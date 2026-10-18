#!/usr/bin/env node
'use strict';

// Servidor HTTP para GPX Library.
// Sirve archivos estáticos + API para la base de datos.
//   GET  /api/db/stats          → estadísticas de la BD
//   POST /api/db/import         → importar GPX (SSE stream)
//   POST /api/db/export         → exportar catalog-data.js (SSE stream)
//   POST /api/db/clean          → limpiar tracks (SSE stream, body JSON)

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const { openDb, withTransaction } = require('./scripts/db');

const PORT = parseInt(process.env.PORT || '8080');
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.gpx':  'application/gpx+xml',
  '.woff2':'font/woff2',
};

// ── Archivos estáticos ─────────────────────────────────────────────
function serveStatic(res, filePath) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ── API /db/stats ──────────────────────────────────────────────────
function apiStats(res) {
  try {
    const db = openDb();
    const summary = db.prepare(`
      SELECT
        COUNT(*)                                              AS tracks,
        SUM(raw_count)                                        AS rawPoints,
        SUM(CASE WHEN cleaned=1 THEN clean_count ELSE 0 END) AS cleanPoints,
        SUM(cleaned)                                          AS cleanedTracks,
        MAX(imported_at)                                      AS lastImport
      FROM tracks
    `).get();

    const cats = db.prepare(`
      SELECT activity AS category,
        COUNT(*)                                              AS count,
        SUM(raw_count)                                        AS rawPoints,
        SUM(CASE WHEN cleaned=1 THEN clean_count ELSE 0 END) AS cleanPoints,
        SUM(cleaned)                                          AS cleaned
      FROM tracks
      GROUP BY activity ORDER BY count DESC
    `).all();

    const dbPath = path.join(ROOT, 'tracks.db');
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const gpxCount = countGpx(path.join(ROOT, 'TracksGps'));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...summary, cats, dbSize, gpxCount }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function countGpx(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) n += countGpx(full);
      else if (e.name.toLowerCase().endsWith('.gpx')) n++;
    }
  } catch {}
  return n;
}

// ── API: ejecutar script con SSE ───────────────────────────────────
function apiRunScript(res, scriptPath, args = []) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'start' });

  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '', lastImported = -1;

  function flush(chunk) {
    buf += chunk.toString().replace(/\r(?!\n)/g, '\n');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const text = raw.trim();
      if (!text) continue;
      // Throttle repeated counter lines ("Importados: N") to every 10
      const m = text.match(/Importados:\s*(\d+)/);
      if (m) {
        const n = parseInt(m[1]);
        if (n - lastImported < 10) continue;
        lastImported = n;
        send({ type: 'progress', text, n });
        continue;
      }
      const type = text.startsWith('✗') || text.startsWith('Error') ? 'error'
                 : text.startsWith('⚠')  ? 'warn' : 'log';
      send({ type, text });
    }
  }

  child.stdout.on('data', flush);
  child.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    if (text) send({ type: 'error', text });
  });
  child.on('close', code => {
    if (buf.trim()) send({ type: 'log', text: buf.trim() });
    send({ type: 'done', code });
    res.end();
  });
  child.on('error', err => {
    send({ type: 'error', text: err.message });
    send({ type: 'done', code: 1 });
    res.end();
  });
}

// ── Parsear cuerpo JSON ───────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ── GPX moving/stopped time ───────────────────────────────────────
function computeGpxTimes(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const pts = [];
  let pos = 0;
  while (true) {
    const ts = content.indexOf('<trkpt', pos);
    if (ts === -1) break;
    const te = content.indexOf('</trkpt>', ts);
    if (te === -1) break;
    const seg = content.substring(ts, te + 8);
    const lat = seg.match(/lat="([^"]+)"/)?.[1];
    const lon = seg.match(/lon="([^"]+)"/)?.[1];
    const tm  = seg.match(/<time>([^<]+)<\/time>/)?.[1];
    if (lat && lon && tm) pts.push({ lat: +lat, lon: +lon, t: new Date(tm.trim()).getTime() });
    pos = te + 8;
  }
  if (pts.length < 2 || !pts[0].t || isNaN(pts[0].t)) return null;
  function h(a, b) {
    const R=6371, D=Math.PI/180, dl=(b.lat-a.lat)*D, dn=(b.lon-a.lon)*D;
    const x=Math.sin(dl/2)**2+Math.cos(a.lat*D)*Math.cos(b.lat*D)*Math.sin(dn/2)**2;
    return R*2*Math.asin(Math.sqrt(x));
  }
  let moving = 0, stopped = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i-1].t) / 1000;
    if (dt <= 0 || dt > 300) continue;
    const speed = h(pts[i-1], pts[i]) / dt * 3600;
    if (speed > 0.8) moving += dt; else stopped += dt;
  }
  return moving + stopped > 0 ? { moving: Math.round(moving), stopped: Math.round(stopped) } : null;
}

// ── API /tracks/:id ───────────────────────────────────────────────
function apiGetTrackById(res, id) {
  try {
    const db = openDb();
    const track = db.prepare(`
      SELECT id, name, file, zone, date,
             distance, elevation_gain, elevation_loss, min_elevation, max_elevation,
             sw_lat, sw_lon, ne_lat, ne_lon, center_lat, center_lon,
             raw_count, clean_count, cleaned,
             activity, province, ccaa, sierra, notes, url,
             road_types, surface_types, moving_time, stopped_time, tags
      FROM tracks WHERE id=?
    `).get(id);
    if (!track) { res.writeHead(404); res.end('Not found'); return; }

    const ptTable = track.cleaned ? 'clean_points' : 'raw_points';
    const MAX_PTS = 800;
    let allPts = db.prepare(`SELECT lat, lon, ele FROM ${ptTable} WHERE track_id=? ORDER BY seq`).all(id);
    if (allPts.length > MAX_PTS) {
      const step = Math.ceil(allPts.length / MAX_PTS);
      allPts = allPts.filter((_, i) => i % step === 0);
    }
    track.points = allPts.map(p => [p.lat, p.lon, p.ele]);
    track.bounds = (track.sw_lat != null)
      ? [[track.sw_lat, track.sw_lon], [track.ne_lat, track.ne_lon]]
      : null;

    // Compute moving/stopped time from GPX if not cached
    if (track.moving_time == null) {
      const gpxPath = path.join(ROOT, 'TracksGps', track.file);
      const times = computeGpxTimes(gpxPath);
      if (times) {
        track.moving_time  = times.moving;
        track.stopped_time = times.stopped;
        db.prepare(`UPDATE tracks SET moving_time=?, stopped_time=? WHERE id=?`)
          .run(times.moving, times.stopped, id);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(track));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API /tracks ───────────────────────────────────────────────────
function apiGetTracks(res) {
  try {
    const db = openDb();
    const tracks = db.prepare(`
      SELECT id, name, file, zone, date,
             distance, elevation_gain, elevation_loss, min_elevation, max_elevation,
             center_lat, center_lon, raw_count, clean_count, cleaned,
             activity, province, ccaa, sierra, notes, url, imported_at, tags
      FROM tracks ORDER BY imported_at DESC, name
    `).all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tracks));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

const EDITABLE_FIELDS = new Set(['name','activity','province','ccaa','sierra','notes','url','tags']);

function deleteTrackById(id) {
  const db = openDb();
  const track = db.prepare('SELECT file FROM tracks WHERE id=?').get(id);
  if (!track) return { ok: false, error: 'Not found' };
  db.prepare('DELETE FROM tracks WHERE id=?').run(id);
  let fileDeleted = false;
  try {
    const fp = path.join(ROOT, 'TracksGps', track.file);
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); fileDeleted = true; }
  } catch (e) { /* file delete failed — DB row is already gone */ }
  return { ok: true, fileDeleted };
}

function apiDeleteTrack(res, id) {
  try {
    const result = deleteTrackById(id);
    if (!result.ok) { res.writeHead(404); res.end(result.error); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiBulkDelete(req, res) {
  try {
    const body = await parseBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) { res.writeHead(400); res.end('No ids'); return; }
    let deleted = 0, filesDeleted = 0;
    for (const id of ids) {
      const r = deleteTrackById(id);
      if (r.ok) { deleted++; if (r.fileDeleted) filesDeleted++; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted, filesDeleted }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiMoveTrack(req, res, id) {
  try {
    const { category: actParam, zone } = await parseBody(req);
    if (!actParam) { res.writeHead(400); res.end('category required'); return; }
    const db = openDb();
    const track = db.prepare('SELECT file FROM tracks WHERE id=?').get(id);
    if (!track) { res.writeHead(404); res.end('Not found'); return; }

    const safe = s => (s || '').replace(/[<>:"/\\|?*]/g,'_').trim();
    const actFolder    = safe(actParam);
    const sierraFolder = zone ? safe(zone) : null;
    const destDir = sierraFolder
      ? path.join(ROOT, 'TracksGps', actFolder, sierraFolder)
      : path.join(ROOT, 'TracksGps', actFolder);

    const oldAbs = path.join(ROOT, track.file.replace(/\//g, path.sep));
    if (!fs.existsSync(oldAbs)) { res.writeHead(404); res.end('GPX file not found on disk'); return; }

    fs.mkdirSync(destDir, { recursive: true });
    const filename = path.basename(oldAbs);
    let newAbs = path.join(destDir, filename);
    if (fs.existsSync(newAbs) && newAbs !== oldAbs) {
      const ext = path.extname(filename), stem = path.basename(filename, ext);
      let n = 2;
      while (fs.existsSync(path.join(destDir, `${stem}_${n}${ext}`))) n++;
      newAbs = path.join(destDir, `${stem}_${n}${ext}`);
    }

    try { fs.renameSync(oldAbs, newAbs); }
    catch { fs.copyFileSync(oldAbs, newAbs); fs.unlinkSync(oldAbs); }

    const newRel = path.relative(ROOT, newAbs).replace(/\\/g, '/');
    const parts  = newRel.split('/');
    const newZone = parts.length > 3 ? parts[2] : null;
    db.prepare('UPDATE tracks SET file=?, activity=?, zone=? WHERE id=?')
      .run(newRel, actParam, newZone ?? null, id);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, file: newRel }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiPatchTrack(req, res, id) {
  try {
    const body   = await parseBody(req);
    const fields = Object.keys(body).filter(k => EDITABLE_FIELDS.has(k));
    if (!fields.length) { res.writeHead(400); res.end('No editable fields'); return; }
    const db   = openDb();
    const sets = fields.map(f => `${f}=?`).join(',');
    db.prepare(`UPDATE tracks SET ${sets} WHERE id=?`).run(...fields.map(f => body[f] ?? null), id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiBulkUpdate(req, res) {
  try {
    const body = await parseBody(req);
    const { ids, fields, notesAppend } = body;
    if (!Array.isArray(ids) || !ids.length || !fields) {
      res.writeHead(400); res.end('Invalid body'); return;
    }
    const editFields = Object.keys(fields).filter(k => EDITABLE_FIELDS.has(k) && fields[k] !== undefined);
    if (!editFields.length) { res.writeHead(400); res.end('No fields'); return; }

    const db = openDb();
    withTransaction(() => {
      if (editFields.includes('notes') && notesAppend) {
        const noteOnly = db.prepare(`UPDATE tracks SET notes = CASE WHEN notes IS NULL THEN ? ELSE notes || char(10) || ? END WHERE id=?`);
        const otherFields = editFields.filter(f => f !== 'notes');
        if (otherFields.length) {
          const stmt = db.prepare(`UPDATE tracks SET ${otherFields.map(f=>`${f}=?`).join(',')} WHERE id=?`);
          for (const id of ids) stmt.run(...otherFields.map(f=>fields[f]??null), id);
        }
        for (const id of ids) noteOnly.run(fields.notes, fields.notes, id);
      } else {
        const stmt = db.prepare(`UPDATE tracks SET ${editFields.map(f=>`${f}=?`).join(',')} WHERE id=?`);
        for (const id of ids) stmt.run(...editFields.map(f=>fields[f]??null), id);
      }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, updated: ids.length }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API: configuración (actividades, sierras) ─────────────────────
function apiConfigList(res, table) {
  try {
    const db = openDb();
    const order = table === 'config_activities' ? 'sort_order, name' : 'name';
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiConfigCreate(req, res, table) {
  try {
    const body = await parseBody(req);
    const db = openDb();
    let id;
    if (table === 'config_activities') {
      const r = db.prepare(
        'INSERT INTO config_activities (name,color,keywords,sort_order,active) VALUES (?,?,?,?,1)'
      ).run(body.name, body.color || null, body.keywords || '', body.sort_order ?? 99);
      id = r.lastInsertRowid;
    } else {
      const r = db.prepare(
        'INSERT INTO config_sierras (name,sw_lat,sw_lon,ne_lat,ne_lon,active) VALUES (?,?,?,?,?,1)'
      ).run(body.name, body.sw_lat ?? null, body.sw_lon ?? null, body.ne_lat ?? null, body.ne_lon ?? null);
      id = r.lastInsertRowid;
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiConfigUpdate(req, res, table, id) {
  try {
    const body = await parseBody(req);
    const db = openDb();
    if (table === 'config_activities') {
      db.prepare(
        'UPDATE config_activities SET name=?,color=?,keywords=?,sort_order=?,active=? WHERE id=?'
      ).run(body.name, body.color ?? null, body.keywords ?? '', body.sort_order ?? 0, body.active ?? 1, id);
    } else {
      db.prepare(
        'UPDATE config_sierras SET name=?,sw_lat=?,sw_lon=?,ne_lat=?,ne_lon=?,active=? WHERE id=?'
      ).run(body.name, body.sw_lat ?? null, body.sw_lon ?? null, body.ne_lat ?? null, body.ne_lon ?? null, body.active ?? 1, id);
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiConfigDelete(res, table, id) {
  try {
    const db = openDb();
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiConfigProvinces(res) {
  try {
    const db = openDb();
    const provinces = db.prepare(
      "SELECT DISTINCT province FROM tracks WHERE province IS NOT NULL AND province != '' ORDER BY province"
    ).all().map(r => r.province);
    const ccaa = db.prepare(
      "SELECT DISTINCT ccaa FROM tracks WHERE ccaa IS NOT NULL AND ccaa != '' ORDER BY ccaa"
    ).all().map(r => r.ccaa);
    const zones = db.prepare(
      "SELECT DISTINCT sierra FROM tracks WHERE sierra IS NOT NULL AND sierra != '' ORDER BY sierra"
    ).all().map(r => r.sierra);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ provinces, ccaa, zones }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API: reorganizar archivos según actividad/sierra en BD ─────────
function apiOrganizeFiles(res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const safe = s => (s || 'General').replace(/[<>:"/\\|?*]/g,'_').trim() || 'General';

  try {
    send({ type: 'start' });
    const db = openDb();
    const tracks = db.prepare('SELECT id, file, activity, sierra, zone FROM tracks').all();
    send({ type: 'log', text: `Revisando ${tracks.length} tracks...` });

    let moved = 0, already = 0, missing = 0, errors = 0;

    for (const track of tracks) {
      const actFolder    = safe(track.activity || 'General');
      const sierraFolder = safe(track.sierra   || track.zone || 'General');
      const filename     = path.basename(track.file);
      const expectedRel  = `TracksGps/${actFolder}/${sierraFolder}/${filename}`;

      if (track.file === expectedRel) { already++; continue; }

      const oldAbs = path.join(ROOT, track.file.replace(/\//g, path.sep));
      if (!fs.existsSync(oldAbs)) {
        send({ type: 'warn', text: `⚠ No encontrado: ${track.file}` });
        missing++;
        continue;
      }

      const destDir = path.join(ROOT, 'TracksGps', actFolder, sierraFolder);
      fs.mkdirSync(destDir, { recursive: true });
      let newAbs = path.join(destDir, filename);
      if (fs.existsSync(newAbs) && newAbs !== oldAbs) {
        const ext = path.extname(filename), stem = path.basename(filename, ext);
        let n = 2;
        while (fs.existsSync(path.join(destDir, `${stem}_${n}${ext}`))) n++;
        newAbs = path.join(destDir, `${stem}_${n}${ext}`);
      }

      try {
        try { fs.renameSync(oldAbs, newAbs); } catch { fs.copyFileSync(oldAbs, newAbs); fs.unlinkSync(oldAbs); }
        const newRel = path.relative(ROOT, newAbs).replace(/\\/g, '/');
        db.prepare('UPDATE tracks SET file=?, zone=? WHERE id=?')
          .run(newRel, sierraFolder, track.id);
        moved++;
        send({ type: 'log', text: `→ ${filename}  ➜  ${actFolder}/${sierraFolder}/` });
      } catch (e) {
        send({ type: 'error', text: `✗ ${filename}: ${e.message}` });
        errors++;
      }
    }

    send({ type: 'log', text: `\n✓ ${moved} movidos · ${already} ya en su sitio · ${missing} no encontrados · ${errors} errores` });
    send({ type: 'done', code: 0 });
  } catch (e) {
    send({ type: 'error', text: e.message });
    send({ type: 'done', code: 1 });
  }
  res.end();
}

// ── API: borrar todos los tracks y archivos GPX ────────────────────
function apiDeleteAll(res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    send({ type: 'start' });
    const db = openDb();
    const { n: trackCount } = db.prepare('SELECT COUNT(*) as n FROM tracks').get();
    send({ type: 'log', text: `Eliminando ${trackCount} tracks de la BD...` });
    db.exec('DELETE FROM tracks');
    send({ type: 'log', text: `✓ BD limpiada (${trackCount} tracks eliminados)` });

    const tracksDir = path.join(ROOT, 'TracksGps');
    let filesDeleted = 0, dirsRemoved = 0;

    function cleanDir(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== '_TEMP_') {
          cleanDir(full);
          try { fs.rmdirSync(full); dirsRemoved++; } catch {}
        } else if (e.name.toLowerCase().endsWith('.gpx')) {
          try { fs.unlinkSync(full); filesDeleted++; } catch {}
        }
      }
    }
    cleanDir(tracksDir);
    send({ type: 'log', text: `✓ ${filesDeleted} archivos GPX eliminados, ${dirsRemoved} carpetas` });
    send({ type: 'done', code: 0 });
  } catch (e) {
    send({ type: 'error', text: e.message });
    send({ type: 'done', code: 1 });
  }
  res.end();
}

// ── Enrutador ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/api/db/stats' && method === 'GET')
    return apiStats(res);

  if (pathname === '/api/db/import' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    return apiRunScript(res, path.join(ROOT,'scripts','import-gpx.js'), force ? ['--force'] : []);
  }

  if (pathname === '/api/db/export' && method === 'POST')
    return apiRunScript(res, path.join(ROOT,'scripts','export-catalog.js'));

  if (pathname === '/api/db/clean' && method === 'POST') {
    const opts = await parseBody(req);
    const args = [];
    if (opts.minDist)  args.push('--min-dist', String(opts.minDist));
    if (opts.maxJump)  args.push('--max-jump', String(opts.maxJump));
    if (opts.rdp)      args.push('--rdp',      String(opts.rdp));
    if (!args.length)  { res.writeHead(400); res.end('No algorithms specified'); return; }
    return apiRunScript(res, path.join(ROOT,'scripts','clean-tracks.js'), args);
  }

  // ── Track CRUD ────────────────────────────────────────────────────
  if (pathname === '/api/tracks' && method === 'GET')
    return apiGetTracks(res);

  if (pathname === '/api/tracks/bulk-update' && method === 'POST')
    return apiBulkUpdate(req, res);

  const trackMoveMatch = pathname.match(/^\/api\/tracks\/(\d+)\/move$/);
  if (trackMoveMatch && method === 'POST')
    return apiMoveTrack(req, res, parseInt(trackMoveMatch[1]));

  const trackMatch = pathname.match(/^\/api\/tracks\/(\d+)$/);
  if (trackMatch && method === 'GET')
    return apiGetTrackById(res, parseInt(trackMatch[1]));
  if (trackMatch && method === 'PATCH')
    return apiPatchTrack(req, res, parseInt(trackMatch[1]));
  if (trackMatch && method === 'DELETE')
    return apiDeleteTrack(res, parseInt(trackMatch[1]));

  if (pathname === '/api/tracks/bulk-delete' && method === 'POST')
    return apiBulkDelete(req, res);

  if (pathname === '/api/db/organize-files' && method === 'POST')
    return apiOrganizeFiles(res);

  if (pathname === '/api/db/import-temp' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    return apiRunScript(res, path.join(ROOT,'scripts','import-from-temp.js'), force ? ['--force'] : []);
  }

  if (pathname === '/api/tracks/delete-all' && method === 'POST')
    return apiDeleteAll(res);

  if (pathname === '/api/db/enrich' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    const ids   = searchParams.get('ids');
    const args  = force ? ['--all'] : ids ? ['--ids', ids] : [];
    return apiRunScript(res, path.join(ROOT,'scripts','enrich-tracks.js'), args);
  }

  if (pathname === '/api/db/enrich-road-types' && (method === 'POST' || method === 'GET')) {
    const force = searchParams.get('force') === '1';
    const ids   = searchParams.get('ids');
    const args  = ids ? ['--ids', ids] : force ? ['--force'] : [];
    return apiRunScript(res, path.join(ROOT,'scripts','enrich-road-types.js'), args);
  }

  // ── Config routes ────────────────────────────────────────────────
  if (pathname === '/api/config/activities' && method === 'GET')
    return apiConfigList(res, 'config_activities');
  if (pathname === '/api/config/activities' && method === 'POST')
    return apiConfigCreate(req, res, 'config_activities');
  const actMatch = pathname.match(/^\/api\/config\/activities\/(\d+)$/);
  if (actMatch && method === 'PATCH')
    return apiConfigUpdate(req, res, 'config_activities', parseInt(actMatch[1]));
  if (actMatch && method === 'DELETE')
    return apiConfigDelete(res, 'config_activities', parseInt(actMatch[1]));

  if (pathname === '/api/config/sierras' && method === 'GET')
    return apiConfigList(res, 'config_sierras');
  if (pathname === '/api/config/sierras' && method === 'POST')
    return apiConfigCreate(req, res, 'config_sierras');
  const sieMatch = pathname.match(/^\/api\/config\/sierras\/(\d+)$/);
  if (sieMatch && method === 'PATCH')
    return apiConfigUpdate(req, res, 'config_sierras', parseInt(sieMatch[1]));
  if (sieMatch && method === 'DELETE')
    return apiConfigDelete(res, 'config_sierras', parseInt(sieMatch[1]));

  if (pathname === '/api/config/provinces' && method === 'GET')
    return apiConfigProvinces(res);

  if (pathname === '/editor' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'editor.html'));

  if (pathname === '/config' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'config.html'));

  if (pathname === '/track' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'track.html'));

  if (pathname === '/api/db/extract-urls' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    return apiRunScript(res, path.join(ROOT,'scripts','extract-urls.js'), force ? ['--force'] : []);
  }

  // Static files — block path traversal
  let filePath = path.normalize(path.join(ROOT, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  serveStatic(res, filePath);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  GPX Library  →  ${url}\n`);
  const { exec } = require('child_process');
  const open = process.platform === 'win32' ? `start ${url}` : `open ${url}`;
  exec(open);
});
