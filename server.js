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
const zlib   = require('zlib');
const { spawn } = require('child_process');
const { openDb, closeDb, withTransaction, DB_PATH } = require('./scripts/db');
const { escXml, updateGpxMetadata } = require('./scripts/gpx-utils');

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

    const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
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
             road_types, surface_types, moving_time, stopped_time, tags,
             ibp_bicycle, ibp_hiking, ibp_running
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
      const gpxPath = path.join(ROOT, track.file);
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

// ── ZIP builder (pure Node — zlib for deflate, no npm deps) ──────
const _crc32t = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crc32t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const cds    = [];
  let   offset = 0;

  for (const { name, data } of entries) {
    const nb   = Buffer.from(name, 'utf8');
    const crc  = crc32(data);
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const pay  = comp.length < data.length ? comp : data;
    const meth = pay === comp ? 8 : 0;

    const lh = Buffer.alloc(30 + nb.length);
    lh.writeUInt32LE(0x04034b50,  0);
    lh.writeUInt16LE(20,          4);
    lh.writeUInt16LE(0x0800,      6);
    lh.writeUInt16LE(meth,        8);
    lh.writeUInt16LE(0,          10);
    lh.writeUInt16LE(0,          12);
    lh.writeUInt32LE(crc,        14);
    lh.writeUInt32LE(pay.length, 18);
    lh.writeUInt32LE(data.length,22);
    lh.writeUInt16LE(nb.length,  26);
    lh.writeUInt16LE(0,          28);
    nb.copy(lh, 30);

    const cd = Buffer.alloc(46 + nb.length);
    cd.writeUInt32LE(0x02014b50,   0);
    cd.writeUInt16LE(20,           4);
    cd.writeUInt16LE(20,           6);
    cd.writeUInt16LE(0x0800,       8);
    cd.writeUInt16LE(meth,        10);
    cd.writeUInt16LE(0,           12);
    cd.writeUInt16LE(0,           14);
    cd.writeUInt32LE(crc,         16);
    cd.writeUInt32LE(pay.length,  20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length,   28);
    cd.writeUInt16LE(0,           30);
    cd.writeUInt16LE(0,           32);
    cd.writeUInt16LE(0,           34);
    cd.writeUInt16LE(0,           36);
    cd.writeUInt32LE(0,           38);
    cd.writeUInt32LE(offset,      42);
    nb.copy(cd, 46);

    locals.push(lh, pay);
    cds.push(cd);
    offset += lh.length + pay.length;
  }

  const cdBuf = Buffer.concat(cds);
  const eocd  = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,      0);
  eocd.writeUInt16LE(0,               4);
  eocd.writeUInt16LE(0,               6);
  eocd.writeUInt16LE(entries.length,  8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length,   12);
  eocd.writeUInt32LE(offset,         16);
  eocd.writeUInt16LE(0,              20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ── Export GPX ────────────────────────────────────────────────────
function simplifyPts(pts, maxN) {
  if (pts.length <= maxN) return pts;
  const out = [], step = (pts.length - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++) out.push(pts[Math.round(i * step)]);
  return out;
}
function buildGpx(tracksData) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="GPX Library" xmlns="http://www.topografix.com/GPX/1/1">',
  ];
  for (const t of tracksData) {
    lines.push('  <trk>');
    lines.push(`    <name>${escXml(t.name)}</name>`);
    if (t.date) lines.push(`    <desc>Fecha: ${t.date.slice(0,10)}</desc>`);
    lines.push('    <trkseg>');
    for (const p of t.pts) {
      const ele = p.ele != null ? `<ele>${p.ele}</ele>` : '';
      lines.push(`      <trkpt lat="${p.lat}" lon="${p.lon}">${ele}</trkpt>`);
    }
    lines.push('    </trkseg>');
    lines.push('  </trk>');
  }
  lines.push('</gpx>');
  return lines.join('\n');
}
function exportGpxResponse(res, tracksData, filename) {
  const gpx = buildGpx(tracksData);
  const safe = filename.replace(/[^\w\s\-áéíóúñÁÉÍÓÚÑ.]/g, '_').trim();
  res.writeHead(200, {
    'Content-Type': 'application/gpx+xml; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
  });
  res.end(gpx);
}
function getTracksForExport(db, ids, mode, maxPts) {
  const fetchRaw   = db.prepare('SELECT lat,lon,ele FROM raw_points   WHERE track_id=? ORDER BY seq');
  const fetchClean = db.prepare('SELECT lat,lon,ele FROM clean_points WHERE track_id=? ORDER BY seq');
  const result = [];
  for (const id of ids) {
    const t = db.prepare('SELECT id,name,date,file,cleaned FROM tracks WHERE id=?').get(id);
    if (!t) continue;
    let pts = t.cleaned ? fetchClean.all(t.id) : fetchRaw.all(t.id);
    if (mode === 'simplified') pts = simplifyPts(pts, maxPts);
    result.push({ id: t.id, name: t.name, date: t.date, file: t.file, pts });
  }
  return result;
}
async function apiExportGpx(req, res) {
  try {
    const body   = await parseBody(req);
    const ids    = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    const mode   = body.mode === 'simplified' ? 'simplified' : 'full';
    const maxPts = parseInt(body.pts) || 500;
    const format = body.format === 'zip' ? 'zip' : 'gpx';
    const layout = body.layout === 'flat' ? 'flat' : 'tree';
    if (!ids.length) { res.writeHead(400); return res.end('ids required'); }
    const db   = openDb();
    const data = getTracksForExport(db, ids, mode, maxPts);
    if (!data.length) { res.writeHead(404); return res.end('No tracks found'); }

    if (format === 'zip') {
      const safeName = s => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'track';
      const usedNames = new Set();
      const entries = data.map(t => {
        const gpx = buildGpx([t]);
        let zipName;
        if (layout === 'tree' && t.file) {
          zipName = t.file.replace(/\\/g, '/');
        } else {
          let base = safeName(t.name) + '.gpx';
          if (usedNames.has(base)) base = safeName(t.name) + '_' + t.id + '.gpx';
          usedNames.add(base);
          zipName = base;
        }
        return { name: zipName, data: Buffer.from(gpx, 'utf8') };
      });
      const zipBuf  = buildZip(entries);
      const zipFile = `gpx-export-${new Date().toISOString().slice(0,10)}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipFile)}`,
        'Content-Length': zipBuf.length,
      });
      res.end(zipBuf);
    } else {
      const filename = data.length === 1
        ? data[0].name + '.gpx'
        : `gpx-export-${new Date().toISOString().slice(0,10)}.gpx`;
      exportGpxResponse(res, data, filename);
    }
  } catch(e) { res.writeHead(500); res.end(e.message); }
}
function apiExportGpxSingle(res, id, searchParams) {
  try {
    const mode   = searchParams.get('mode') === 'simplified' ? 'simplified' : 'full';
    const maxPts = parseInt(searchParams.get('pts')) || 500;
    const db   = openDb();
    const data = getTracksForExport(db, [id], mode, maxPts);
    if (!data.length) { res.writeHead(404); return res.end('Not found'); }
    exportGpxResponse(res, data, data[0].name + '.gpx');
  } catch(e) { res.writeHead(500); res.end(e.message); }
}

// ── API: list _TEMP_ files ────────────────────────────────────────
function apiTempFiles(res) {
  try {
    const TEMP_DIR = path.join(ROOT, 'TracksGps', '_TEMP_');
    function collect(dir, base) {
      const out = [];
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = base ? base + '/' + e.name : e.name;
          if (e.isDirectory() && e.name !== '_REVIEW_') out.push(...collect(path.join(dir, e.name), rel));
          else if (e.name.toLowerCase().endsWith('.gpx')) out.push({ rel, name: e.name });
        }
      } catch {}
      return out;
    }
    const files = fs.existsSync(TEMP_DIR) ? collect(TEMP_DIR, '') : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
  } catch(e) { res.writeHead(500); res.end(e.message); }
}

// ── API /tracks ───────────────────────────────────────────────────
function apiGetTracks(res) {
  try {
    const db = openDb();
    const tracks = db.prepare(`
      SELECT id, name, file, zone, date,
             distance, elevation_gain, elevation_loss, min_elevation, max_elevation,
             center_lat, center_lon, raw_count, clean_count, cleaned,
             activity, province, ccaa, sierra, notes, url, imported_at, tags,
             ibp_bicycle, ibp_hiking, ibp_running
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
    const fp = path.join(ROOT, track.file);
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

    // Write activity (and any existing name/notes/url) back to the moved GPX
    const tData = db.prepare('SELECT name, activity, notes, url FROM tracks WHERE id=?').get(id);
    if (tData) {
      const gf = { name: tData.name, activity: tData.activity };
      if (tData.notes != null) gf.notes = tData.notes;
      if (tData.url   != null) gf.url   = tData.url;
      updateGpxMetadata(newAbs, gf);
    }

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

    // Write name/activity/notes back to GPX file
    const gpxFields = Object.fromEntries(
      fields.filter(f => ['name','activity','notes','url'].includes(f)).map(f => [f, body[f]])
    );
    if (Object.keys(gpxFields).length) {
      const track = db.prepare('SELECT file FROM tracks WHERE id=?').get(id);
      if (track) updateGpxMetadata(path.join(ROOT, track.file), gpxFields);
    }

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
        // Write attrs to GPX at new location
        const tData = db.prepare('SELECT name, activity, notes, url FROM tracks WHERE id=?').get(track.id);
        if (tData) {
          const gf = { name: tData.name, activity: tData.activity };
          if (tData.notes != null) gf.notes = tData.notes;
          if (tData.url   != null) gf.url   = tData.url;
          updateGpxMetadata(newAbs, gf);
        }
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

// ── Admin API ─────────────────────────────────────────────────────
const BACKUPS_DIR = path.join(path.dirname(DB_PATH), 'backups');

function apiAdminStats(res) {
  try {
    const db = openDb();
    const summary = db.prepare(`
      SELECT COUNT(*) AS tracks,
        SUM(raw_count) AS rawPoints,
        SUM(CASE WHEN cleaned=1 THEN clean_count ELSE 0 END) AS cleanPoints,
        SUM(cleaned) AS cleanedTracks,
        MAX(imported_at) AS lastImport
      FROM tracks
    `).get();
    const cats = db.prepare(`
      SELECT activity AS category,
        COUNT(*) AS count,
        SUM(raw_count) AS rawPoints,
        SUM(CASE WHEN cleaned=1 THEN clean_count ELSE 0 END) AS cleanPoints,
        SUM(cleaned) AS cleaned
      FROM tracks
      GROUP BY activity ORDER BY count DESC
    `).all();
    const dbSize  = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    const walSize = fs.existsSync(DB_PATH + '-wal') ? fs.statSync(DB_PATH + '-wal').size : 0;
    const gpxCount = countGpx(path.join(ROOT, 'TracksGps'));
    let backups = [];
    try {
      backups = fs.readdirSync(BACKUPS_DIR)
        .filter(f => f.endsWith('.db'))
        .map(f => {
          const stat = fs.statSync(path.join(BACKUPS_DIR, f));
          return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...summary, cats, dbSize, walSize, gpxCount, backups }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiAdminBackup(res) {
  try {
    const db = openDb();
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUPS_DIR, `tracks-${ts}.db`);
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const size = fs.statSync(dest).size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: path.basename(dest), size }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiAdminBackups(res) {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const backups = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(backups));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiAdminRestore(res, filename) {
  try {
    if (/[/\\]/.test(filename)) { res.writeHead(400); res.end('Invalid filename'); return; }
    const src = path.join(BACKUPS_DIR, filename);
    if (!src.startsWith(BACKUPS_DIR) || !fs.existsSync(src)) {
      res.writeHead(404); res.end('Backup not found'); return;
    }
    closeDb();
    fs.copyFileSync(src, DB_PATH);
    // Remove WAL/SHM so SQLite starts fresh
    for (const ext of ['-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + ext); } catch {}
    }
    openDb(); // reopen
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiAdminDeleteBackup(res, filename) {
  try {
    if (/[/\\]/.test(filename)) { res.writeHead(400); res.end('Invalid filename'); return; }
    const target = path.join(BACKUPS_DIR, filename);
    if (!target.startsWith(BACKUPS_DIR) || !fs.existsSync(target)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    fs.unlinkSync(target);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiAdminVacuum(res) {
  try {
    const db = openDb();
    db.exec('VACUUM');
    const size = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dbSize: size }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiAdminIntegrity(res) {
  try {
    const db = openDb();
    const rows = db.prepare('PRAGMA integrity_check').all();
    const ok   = rows.length === 1 && rows[0].integrity_check === 'ok';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, result: rows.map(r => r.integrity_check) }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
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

  if (pathname === '/api/db/export' && method === 'POST') {
    const opts = await parseBody(req);
    const args = [];
    if (opts.maxPoints) args.push('--max-points', String(parseInt(opts.maxPoints)));
    return apiRunScript(res, path.join(ROOT,'scripts','export-catalog.js'), args);
  }

  if (pathname === '/api/db/clean' && method === 'POST') {
    const opts = await parseBody(req);
    const args = [];
    if (opts.minDist)  args.push('--min-dist', String(opts.minDist));
    if (opts.maxJump)  args.push('--max-jump', String(opts.maxJump));
    if (opts.rdp)      args.push('--rdp',      String(opts.rdp));
    if (!args.length)  { res.writeHead(400); res.end('No algorithms specified'); return; }
    return apiRunScript(res, path.join(ROOT,'scripts','clean-tracks.js'), args);
  }

  // ── Export GPX ────────────────────────────────────────────────────
  if (pathname === '/api/tracks/export-gpx' && method === 'POST')
    return apiExportGpx(req, res);

  const exportMatch = pathname.match(/^\/api\/tracks\/(\d+)\/export-gpx$/);
  if (exportMatch && method === 'GET')
    return apiExportGpxSingle(res, parseInt(exportMatch[1]), searchParams);

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

  if (pathname === '/api/db/temp-files' && method === 'GET')
    return apiTempFiles(res);

  if (pathname === '/api/db/import-temp' && method === 'POST') {
    const body  = await parseBody(req).catch(() => ({}));
    const force = body.force || searchParams.get('force') === '1';
    const files = Array.isArray(body.files) && body.files.length ? body.files : null;
    const args  = [];
    if (force) args.push('--force');
    if (files) args.push('--files', files.join('|'));
    return apiRunScript(res, path.join(ROOT,'scripts','import-from-temp.js'), args);
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

  // ── IBP Index ────────────────────────────────────────────────────
  const IBP_KEY_FILE = path.join(ROOT, 'ibp.key');
  if (pathname === '/api/config/ibp-key' && method === 'GET') {
    const hasKey = fs.existsSync(IBP_KEY_FILE) && fs.readFileSync(IBP_KEY_FILE,'utf8').trim().length > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ hasKey }));
  }
  if (pathname === '/api/config/ibp-key' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const key  = (body.key || '').trim();
      if (!key) { res.writeHead(400); return res.end(JSON.stringify({ error: 'key vacía' })); }
      fs.writeFileSync(IBP_KEY_FILE, key, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (pathname === '/api/db/calc-ibp' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    const ids   = searchParams.get('ids');
    const args  = [];
    if (force) args.push('--force');
    if (ids)   { args.push('--ids'); args.push(ids); }
    return apiRunScript(res, path.join(ROOT,'scripts','calc-ibp.js'), args);
  }

  // ── Admin routes ─────────────────────────────────────────────────
  if (pathname === '/admin' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'admin.html'));

  if (pathname === '/api/admin/stats' && method === 'GET')
    return apiAdminStats(res);
  if (pathname === '/api/admin/backup' && method === 'POST')
    return apiAdminBackup(res);
  if (pathname === '/api/admin/backups' && method === 'GET')
    return apiAdminBackups(res);
  if (pathname === '/api/admin/vacuum' && method === 'POST')
    return apiAdminVacuum(res);
  if (pathname === '/api/admin/integrity' && method === 'GET')
    return apiAdminIntegrity(res);

  const restoreMatch = pathname.match(/^\/api\/admin\/restore\/(.+)$/);
  if (restoreMatch && method === 'POST')
    return apiAdminRestore(res, decodeURIComponent(restoreMatch[1]));

  const delBackupMatch = pathname.match(/^\/api\/admin\/backups\/(.+)$/);
  if (delBackupMatch && method === 'DELETE')
    return apiAdminDeleteBackup(res, decodeURIComponent(delBackupMatch[1]));

  if (pathname === '/editor' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'editor.html'));

  if (pathname === '/config' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'config.html'));

  if (pathname === '/track' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'track.html'));

  if (pathname === '/api/db/write-gpx-attrs' && method === 'POST') {
    const ids = searchParams.get('ids');
    const args = ids ? ['--ids', ids] : [];
    return apiRunScript(res, path.join(ROOT,'scripts','write-gpx-attrs.js'), args);
  }

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
