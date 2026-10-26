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
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const { applyGpxMetadata, buildGpx, metaFromTrack, parseGpx, computeTimes, sampleEvenly } = require('./domain');
const { getRepo, createRepo } = require('./repo');
const { EDITABLE_FIELDS } = require('./repo/columns');
const { openSql } = require('./repo/sql');
// Engine-neutral SQL on the active engine (shares the repository's Postgres pool; never closed here).
const sqlDb = () => openSql({ pool: repo.pool });
let repo = getRepo();   // reassigned when the engine is switched from Admin
const { downloadName, readTrackFile, deleteTrackFile, gpxText } = require('./scripts/store');
const { createBlob } = require('./blob');
// Store of the original GPX files (local folder or S3), swappable like `repo`.
let blob = createBlob();

const PORT = parseInt(process.env.PORT || '8080');
const ROOT = __dirname;

let _oauthState = null; // { state, ts } — CSRF token para el flujo OAuth

// ── Operations log ─────────────────────────────────────────────────
const { LOGS_DIR, logFilePath, appendLog } = require('./scripts/applog');

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
// Public: the pages and styles at the root, the browser scripts listed here and assets/.
const PUBLIC_JS = new Set(['visor.js', 'theme.js', 'import-ui.js']);
function isPublicFile(rel) {
  if (rel.split('/').some(s => s.startsWith('.'))) return false;
  if (rel.startsWith('assets/')) return true;
  if (rel.includes('/')) return false;
  const ext = path.extname(rel).toLowerCase();
  return ext === '.html' || ext === '.css' || PUBLIC_JS.has(rel);
}

function serveStatic(res, filePath, req) {
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return;
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', ETag: etag });
      res.end(data);
    });
  });
}

// ── API /db/stats ──────────────────────────────────────────────────
// Summary, per-activity breakdown and storage size, identical on both engines.
async function dbSummary() {
  const db = sqlDb();
  const sums = `CAST(SUM(raw_count) AS INTEGER) AS rawPoints,
        CAST(SUM(CASE WHEN cleaned=1 THEN clean_count ELSE 0 END) AS INTEGER) AS cleanPoints`;
  const summary = await db.get(`
      SELECT CAST(COUNT(*) AS INTEGER) AS tracks, ${sums},
        CAST(SUM(cleaned) AS INTEGER) AS cleanedTracks,
        to_char(MAX(imported_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS lastImport
      FROM tracks`);
  const cats = await db.all(`
      SELECT activity AS category, CAST(COUNT(*) AS INTEGER) AS count, ${sums},
        CAST(SUM(cleaned) AS INTEGER) AS cleaned
      FROM tracks
      GROUP BY activity ORDER BY count DESC, activity ${db.BIN}`);
  // Postgres folds unquoted aliases to lower case
  const fix = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [{ rawpoints: 'rawPoints', cleanpoints: 'cleanPoints', cleanedtracks: 'cleanedTracks', lastimport: 'lastImport' }[k] || k, v]));
  const dbSize = Number((await db.get('SELECT pg_database_size(current_database()) AS n')).n);
  return { summary: fix(summary), cats: cats.map(fix), dbSize, walSize: 0 };
}

async function apiStats(res) {
  try {
    const { summary, cats, dbSize } = await dbSummary();
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

// ── Trabajos en segundo plano (cola en la BD) ──────────────────────
// Long operations (imports, OSM, IBP…) are queued as jobs and run by a worker: embedded here for local
// use, or the separate `worker` service in docker-compose (EMBEDDED_WORKER=0). The pages still get the
// same SSE stream: apiRunScript queues the job and relays its output from the database, so a closed
// browser no longer stops an import.
const { createQueue, TERMINAL } = require('./queue');
const { createWorker } = require('./queue/worker');
const { JOBS, summarize } = require('./queue/jobs');
const jobQueue = () => createQueue(sqlDb());

const worker = process.env.EMBEDDED_WORKER === '0' ? null : createWorker({
  getQueue: jobQueue,
  isPaused: () => switchingStorage,
  onFinish: (job, code, lines) => {
    appendLog(code === 0 ? 'info' : 'error', job.type, `${job.type} ${code === 0 ? 'completado' : code === 130 ? 'cancelado' : 'fallido'}`,
      { job: job.id, ...summarize(lines, code) });
    if (code === 0) invalidateCatalogCache();
  },
});

async function apiRunScript(res, scriptPath, args = []) {
  const type = path.basename(scriptPath, '.js');
  try {
    if (!JOBS[type]) throw new Error(`Tipo de trabajo desconocido: ${type}`);
    if (switchingStorage) throw new Error('Hay un cambio de almacén en curso; inténtalo en un momento');
    const job = await jobQueue().enqueue(type, { args }, { maxAttempts: JOBS[type].maxAttempts || 1 });
    appendLog('info', type, `${type} en cola`, { job: job.id, args });
    return streamJob(res, job.id);
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'error', text: '✗ ' + e.message })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', code: 1 })}\n\n`);
    res.end();
  }
}

// SSE relay of a job: its output lines as they are stored, then `done` when it finishes.
// Leaving the page only stops the relay, never the job.
async function streamJob(res, id) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let closed = false, seq = 0, lastImported = -1, announced = false;
  res.on('close', () => { closed = true; });
  const relay = lines => {
    for (const l of lines) {
      seq = l.seq;
      const m = l.text.match(/Importados:\s*(\d+)/);                // throttle "Importados: N" counters
      if (m) {
        const n = parseInt(m[1]);
        if (n - lastImported >= 10) { lastImported = n; send({ type: 'progress', text: l.text, n }); }
        continue;
      }
      send({ type: l.level, text: l.text });
    }
  };
  send({ type: 'start', job: id });
  try {
    while (!closed) {
      const q = jobQueue();
      relay(await q.logs(id, seq));
      const job = await q.get(id);
      if (!job) { send({ type: 'error', text: '✗ El trabajo ya no existe' }); send({ type: 'done', code: 1 }); break; }
      if (job.status === 'queued' && !job.startedAt && !announced) { announced = true; send({ type: 'log', text: `En cola (trabajo #${id})…` }); }
      if (TERMINAL.includes(job.status)) {
        relay(await q.logs(id, seq));                                  // lines written just before finishing
        send({ type: 'done', code: job.status === 'done' ? 0 : 1, status: job.status });
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }
  } catch (e) {
    send({ type: 'error', text: '✗ ' + e.message });
    send({ type: 'done', code: 1 });
  }
  res.end();
}

async function apiJobs(res, searchParams) {
  try {
    const limit = Math.min(200, parseInt(searchParams.get('limit')) || 50);
    const jobs = (await jobQueue().list({ limit })).map(j => ({ ...j, label: JOBS[j.type]?.label || j.type }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobs, worker: worker ? 'embedded' : 'external' }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiJobAction(res, id, action) {
  try {
    const q = jobQueue();
    const out = action === 'cancel' ? { status: await q.cancel(id) } : { job: await q.retry(id) };
    const fail = action === 'cancel' ? !out.status && 'El trabajo ya había terminado' : !out.job && 'Solo se puede reintentar un trabajo terminado';
    if (fail) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: fail })); }
    appendLog('info', 'jobs', `Trabajo ${id}: ${action === 'cancel' ? 'cancelación pedida' : `reintentado como ${out.job.id}`}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// Jobs waiting or running: the engine/store switches wait for them
async function busyJobs() {
  try { return (await jobQueue().activeCount()) > 0; } catch { return false; }
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
async function computeGpxTimes(file) {
  try { const buf = await readTrackFile(file, blob); return buf ? computeTimes(parseGpx(gpxText(buf)).points) : null; } catch { return null; }
}

// ── API /tracks/:id ───────────────────────────────────────────────
async function apiGetTrackById(res, id, full = false) {
  try {
    const track = await repo.getTrack(id);
    if (!track) { res.writeHead(404); res.end('Not found'); return; }

    const MAX_PTS = 800;
    let allPts = await repo.getPoints(id, { clean: !!track.cleaned });
    if (!full && allPts.length > MAX_PTS) {
      const step = Math.ceil(allPts.length / MAX_PTS);
      allPts = allPts.filter((_, i) => i % step === 0);
    }
    track.points = allPts.map(p => [p.lat, p.lon, p.ele]);
    track.bounds = (track.sw_lat != null)
      ? [[track.sw_lat, track.sw_lon], [track.ne_lat, track.ne_lon]]
      : null;

    // Compute moving/stopped time from GPX if not cached
    if (track.moving_time == null) {
      const times = await computeGpxTimes(track.file);
      if (times) {
        track.moving_time  = times.moving;
        track.stopped_time = times.stopped;
        await repo.setTimes(id, times.moving, times.stopped);
      }
    }

    track.tags      = track.tags      ? (() => { try { return JSON.parse(track.tags);      } catch { return [];   } })() : [];
    track.waypoints = track.waypoints_json ? (() => { try { return JSON.parse(track.waypoints_json); } catch { return []; } })() : [];
    delete track.waypoints_json;
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
function exportGpxResponse(res, tracksData, filename) {
  const gpx = buildGpx(tracksData);
  const safe = filename.replace(/[^\w\s\-áéíóúñÁÉÍÓÚÑ.]/g, '_').trim();
  res.writeHead(200, {
    'Content-Type': 'application/gpx+xml; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
  });
  res.end(gpx);
}
async function getTracksForExport(ids, mode, maxPts) {
  const result = [];
  for (const id of ids) {
    const t = await repo.getTrack(id);
    if (!t) continue;
    let pts = await repo.getPoints(t.id, { clean: !!t.cleaned });
    if (mode === 'simplified') pts = sampleEvenly(pts, maxPts);
    result.push({ id: t.id, name: t.name, date: t.date, file: t.file, activity: t.activity, sierra: t.sierra || t.zone, pts });
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
    const data = await getTracksForExport(ids, mode, maxPts);
    if (!data.length) { res.writeHead(404); return res.end('No tracks found'); }

    if (format === 'zip') {
      const safeName = s => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'track';
      const usedNames = new Set();
      const entries = data.map(t => {
        const gpx = buildGpx([t]);
        let zipName;
        const dir = layout === 'tree' ? `${safeName(t.activity || 'Sin actividad')}/${safeName(t.sierra || 'General')}/` : '';
        let base = dir + safeName(t.name) + '.gpx';
        if (usedNames.has(base)) base = dir + safeName(t.name) + '_' + t.id + '.gpx';
        usedNames.add(base);
        zipName = base;
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
async function apiExportGpxSingle(res, id, searchParams) {
  try {
    const mode   = searchParams.get('mode') === 'simplified' ? 'simplified' : 'full';
    const maxPts = parseInt(searchParams.get('pts')) || 500;
    const data = await getTracksForExport([id], mode, maxPts);
    if (!data.length) { res.writeHead(404); return res.end('Not found'); }
    exportGpxResponse(res, data, data[0].name + '.gpx');
  } catch(e) { res.writeHead(500); res.end(e.message); }
}

// Original GPX with the current DB metadata applied (the stored file is never rewritten); null if missing.
async function originalGpxWithMeta(track) {
  const buf = await readTrackFile(track.file, blob);
  return buf ? applyGpxMetadata(gpxText(buf), metaFromTrack(track)) : null;
}

// GET /api/tracks/:id/gpx           → original GPX file from disk
// GET /api/tracks/:id/gpx?pts=300   → generated GPX with N simplified points
async function apiDownloadGpx(res, id, searchParams) {
  try {
    const track = await repo.getTrack(id);
    if (!track) { res.writeHead(404); res.end('Not found'); return; }

    const ptsParam = searchParams.get('pts');
    if (!ptsParam || ptsParam === 'all') {
      const gpx = await originalGpxWithMeta(track);
      if (gpx == null) { res.writeHead(404); res.end('GPX file not found in the store'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/gpx+xml; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName(track.name))}`,
      });
      res.end(gpx);
    } else {
      const maxPts = Math.max(2, parseInt(ptsParam) || 300);
      const data = await getTracksForExport([id], 'simplified', maxPts);
      if (!data.length) { res.writeHead(404); res.end('Not found'); return; }
      exportGpxResponse(res, data, data[0].name + '.gpx');
    }
  } catch(e) { res.writeHead(500); res.end(e.message); }
}

// ── API: list _TEMP_ files ────────────────────────────────────────
function apiTempFiles(res, srcDir) {
  try {
    const dir = srcDir ? path.normalize(path.resolve(srcDir)) : path.join(ROOT, 'TracksGps', '_TEMP_');
    function collect(d, base) {
      const out = [];
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const rel = base ? base + '/' + e.name : e.name;
          if (e.isDirectory() && e.name !== '_REVIEW_') out.push(...collect(path.join(d, e.name), rel));
          else if (e.name.toLowerCase().endsWith('.gpx')) out.push({ rel, name: e.name });
        }
      } catch {}
      return out;
    }
    const files = fs.existsSync(dir) ? collect(dir, '') : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
  } catch(e) { res.writeHead(500); res.end(e.message); }
}

// ── API /catalog ─────────────────────────────────────────────────
// Stats come from the tracks table (pre-computed at import time).
// Only points are fetched per-track for simplification.
// Result is cached in memory and invalidated on any write.
const MAX_CATALOG_PTS = 300;

let _catalogCache = null;      // JSON string
let _catalogCacheSize = 0;
let _catalogEtag = '';

function invalidateCatalogCache() { _catalogCache = null; }


async function buildCatalog() {
  const tracks = await repo.catalogTracks();
  const catalog = [];
  for(const t of tracks){
    if(t.sw_lat==null || t.ne_lat==null) continue;
    let points;
    if (t.catalog_pts) {
      try { points = JSON.parse(t.catalog_pts); } catch { continue; }
    } else {
      const pts = await repo.getPoints(t.id, { clean: !!t.cleaned });
      if(pts.length<2) continue;
      const disp = sampleEvenly(pts, MAX_CATALOG_PTS);
      points = disp.map(p=>[
        Math.round(p.lat*100000)/100000,
        Math.round(p.lon*100000)/100000,
        p.ele!=null?Math.round(p.ele):null,
      ]);
    }
    if(!Array.isArray(points) || points.length < 2) continue;
    catalog.push({
      id:            t.id,
      name:          t.name,
      file:          t.file,
      zone:          t.zone,
      date:          t.date,
      activity:      t.activity||null,
      sierra:        t.sierra||null,
      ccaa:          t.ccaa||null,
      tags:          t.tags ? JSON.parse(t.tags) : [],
      distance:      t.distance,
      elevationGain: t.elevation_gain,
      elevationLoss: t.elevation_loss,
      minElevation:  t.min_elevation  != null ? Math.round(t.min_elevation)  : null,
      maxElevation:  t.max_elevation  != null ? Math.round(t.max_elevation)  : null,
      bounds:        [[t.sw_lat,t.sw_lon],[t.ne_lat,t.ne_lon]],
      center:        [Math.round(t.center_lat*10000)/10000, Math.round(t.center_lon*10000)/10000],
      color:         t.color||null,
      ibp_bicycle:   t.ibp_bicycle  != null ? Math.round(t.ibp_bicycle)  : null,
      ibp_hiking:    t.ibp_hiking   != null ? Math.round(t.ibp_hiking)   : null,
      ibp_running:   t.ibp_running  != null ? Math.round(t.ibp_running)  : null,
      hasOsm:        !!(t.road_types && t.road_types !== '{}'),
      movingTime:    t.moving_time  || null,
      stoppedTime:   t.stopped_time || null,
      circular:      !!t.circular,
      points,
    });
  }
  return JSON.stringify(catalog);
}

let _catalogDataVersion = null;
async function apiCatalog(req, res) {
  try {
    const version = await jobQueue().dataVersion().catch(() => null);   // a job finished since → rebuild
    if (version !== _catalogDataVersion) { _catalogDataVersion = version; _catalogCache = null; }
    if (!_catalogCache) {
      _catalogCache = await buildCatalog();
      _catalogCacheSize = Buffer.byteLength(_catalogCache);
      _catalogEtag = `"cat-${Date.now().toString(36)}"`;
      console.log(`[catalog] built: ${Math.round(_catalogCacheSize/1024)}KB`);
    }
    if (req.headers['if-none-match'] === _catalogEtag) {
      res.writeHead(304, { ETag: _catalogEtag, 'Cache-Control': 'no-cache' }); return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ETag: _catalogEtag });
    res.end(_catalogCache);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API /tracks ───────────────────────────────────────────────────
async function apiGetTracks(res) {
  try {
    const tracks = await repo.listTracks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tracks));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}


async function deleteTrackById(id) {
  const file = await repo.deleteTrack(id);
  if (!file) return { ok: false, error: 'Not found' };
  invalidateCatalogCache();
  let fileDeleted = false;
  try { fileDeleted = await deleteTrackFile(file, blob); }
  catch (e) { console.error(`[store] no se pudo borrar ${file}: ${e.message}`); }   // the DB row is already gone
  return { ok: true, fileDeleted };
}

async function apiDeleteTrack(res, id) {
  try {
    const result = await deleteTrackById(id);
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
      const r = await deleteTrackById(id);
      if (r.ok) { deleted++; if (r.fileDeleted) filesDeleted++; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted, filesDeleted }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// Files live in the immutable store, so "moving" a track only changes its metadata.
async function apiMoveTrack(req, res, id) {
  try {
    const { category: actParam, zone } = await parseBody(req);
    if (!actParam) { res.writeHead(400); res.end('category required'); return; }
    if (!(await repo.moveTrack(id, actParam, zone))) { res.writeHead(404); res.end('Not found'); return; }
    invalidateCatalogCache();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    // The GPX is immutable: metadata lives only in the DB (it is applied on download).
    await repo.updateTrack(id, body);
    invalidateCatalogCache();
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
    await repo.bulkUpdate(ids.map(Number).filter(Boolean), fields, !!notesAppend);
    invalidateCatalogCache();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, updated: ids.length }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API: configuración (actividades, sierras) ─────────────────────
async function apiConfigList(res, table) {
  try {
    const rows = await repo.listConfig(table);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiConfigCreate(req, res, table) {
  try {
    const row = await repo.createConfig(table, await parseBody(req));
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiConfigUpdate(req, res, table, id) {
  try {
    const row = await repo.updateConfig(table, id, await parseBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiConfigDelete(res, table, id) {
  try {
    await repo.deleteConfig(table, id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiConfigProvinces(res) {
  try {
    const geo = await repo.geo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(geo));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Admin API ─────────────────────────────────────────────────────
const BACKUPS_DIR        = path.join(ROOT, 'data', 'backups');
const BACKUP_CONFIG_PATH = path.join(ROOT, 'data', 'backup-config.json');

function readBackupConfig() {
  try { return JSON.parse(fs.readFileSync(BACKUP_CONFIG_PATH, 'utf8')); } catch { return { maxKeep: 10 }; }
}
function writeBackupConfig(cfg) {
  fs.writeFileSync(BACKUP_CONFIG_PATH, JSON.stringify(cfg), 'utf8');
}

function listBackupFiles() {
  try {
    return fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.db.gz') || f.endsWith('.db'))
      .map(f => { const s = fs.statSync(path.join(BACKUPS_DIR, f)); return { name: f, size: s.size, mtime: s.mtime.toISOString() }; })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch { return []; }
}

function pruneBackups(maxKeep) {
  const files = listBackupFiles();
  for (const f of files.slice(maxKeep)) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f.name)); } catch {}
  }
}

// Backups are always a gzipped SQLite file, so they restore into either engine.
// With Postgres the data is dumped to SQLite by db-copy (which verifies the copy).
async function createBackupFile() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpPath = path.join(BACKUPS_DIR, `tracks-${ts}.db`);
  const gz      = tmpPath + '.gz';
  const out = [];
  const code = await runStreaming(process.execPath,
    [path.join(ROOT, 'scripts', 'db-copy.js'), '--to', 'sqlite', '--sqlite', tmpPath, '--replace'], l => out.push(l));
  if (code !== 0) throw new Error('Volcado de PostgreSQL fallido: ' + out.slice(-3).join(' · '));
  await pipeline(fs.createReadStream(tmpPath), zlib.createGzip({ level: 6 }), fs.createWriteStream(gz));
  fs.unlinkSync(tmpPath);
  return gz;
}

async function apiAdminStats(res) {
  try {
    const { summary, cats, dbSize, walSize } = await dbSummary();
    const backups = listBackupFiles();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...summary, cats, dbSize, gpxCount: summary.tracks, backups, driver: 'postgres' }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiAdminBackup(res) {
  try {
    const gz   = await createBackupFile();
    const cfg  = readBackupConfig();
    pruneBackups(cfg.maxKeep || 10);
    const size = fs.statSync(gz).size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: path.basename(gz), size }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function apiAdminBackups(res) {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listBackupFiles()));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiAdminRestore(res, filename) {
  try {
    if (/[/\\]/.test(filename)) { res.writeHead(400); res.end('Invalid filename'); return; }
    const src = path.join(BACKUPS_DIR, filename);
    if (!src.startsWith(BACKUPS_DIR) || !fs.existsSync(src)) {
      res.writeHead(404); res.end('Backup not found'); return;
    }
    // Unpack the SQLite backup and load it into Postgres with db-copy
    const tmp = path.join(BACKUPS_DIR, `restore-${Date.now()}.tmp.db`);
    const rm = () => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch {} } };
    try {
      if (filename.endsWith('.gz')) await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(tmp));
      else fs.copyFileSync(src, tmp);
      const out = [];
      const code = await runStreaming(process.execPath, [path.join(ROOT, 'scripts', 'db-copy.js'), '--to', 'postgres', '--replace'],
        l => out.push(l), { env: { ...process.env, SQLITE_PATH: tmp } });
      if (code !== 0) throw new Error('Carga en PostgreSQL fallida: ' + out.slice(-3).join(' · '));
    } finally { rm(); }
    invalidateCatalogCache();
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

async function apiAdminVacuum(res) {
  try {
    await repo.pool.query('VACUUM (ANALYZE) tracks, config_activities, config_sierras');
    const { dbSize } = await dbSummary();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dbSize }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// Postgres has no integrity_check: verify geometries and that elevations and counts match the points.
async function pgIntegrity() {
  const r = (await repo.pool.query(`
    SELECT
      count(*) FILTER (WHERE geom IS NOT NULL AND NOT ST_IsValid(geom))::int                                    AS geom_invalid,
      count(*) FILTER (WHERE geom_clean IS NOT NULL AND NOT ST_IsValid(geom_clean))::int                        AS geom_clean_invalid,
      count(*) FILTER (WHERE ele IS NOT NULL AND cardinality(ele) <> COALESCE(ST_NPoints(geom), 0))::int         AS ele_mismatch,
      count(*) FILTER (WHERE ele_clean IS NOT NULL AND cardinality(ele_clean) <> COALESCE(ST_NPoints(geom_clean), 0))::int AS ele_clean_mismatch,
      count(*) FILTER (WHERE raw_count <> COALESCE(ST_NPoints(geom), 0))::int                                   AS raw_count_mismatch,
      count(*) FILTER (WHERE cleaned = 1 AND clean_count <> COALESCE(ST_NPoints(geom_clean), 0))::int           AS clean_count_mismatch
    FROM tracks`)).rows[0];
  const label = { geom_invalid: 'geometría no válida', geom_clean_invalid: 'geometría limpia no válida',
    ele_mismatch: 'altitudes ≠ puntos', ele_clean_mismatch: 'altitudes limpias ≠ puntos limpios',
    raw_count_mismatch: 'raw_count ≠ puntos', clean_count_mismatch: 'clean_count ≠ puntos limpios' };
  const bad = Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${label[k]}: ${n} rutas`);
  return bad.length ? bad : ['ok'];
}

async function apiAdminIntegrity(res) {
  try {
    const result = await pgIntegrity();
    const ok = result.length === 1 && result[0] === 'ok';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, result }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Database engine status (Admin → Base de datos) ─────────────────────
// In a deployment (docker-compose) engine and store are fixed by its environment, not by Admin.
const BACKENDS_LOCKED = !!process.env.LOCK_BACKENDS;
const LOCKED_MSG = 'Fijado por el despliegue (docker-compose): cámbialo en su configuración';

async function postgresStatus() {
  const config = require('./config');
  if (!config.DATABASE_URL) return { configured: false, reachable: false };
  if (repo.driver === 'postgres') {
    const r = await repo.pool.query("SELECT count(*)::int AS n FROM tracks");
    return { configured: true, reachable: true, tracks: r.rows[0].n };
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2500 });
  try {
    const has = (await pool.query("SELECT to_regclass('public.tracks') IS NOT NULL AS ok")).rows[0].ok;
    const tracks = has ? (await pool.query('SELECT count(*)::int AS n FROM tracks')).rows[0].n : 0;
    return { configured: true, reachable: true, tracks };
  } catch (e) {
    return { configured: true, reachable: false, error: e.code === 'ECONNREFUSED' ? 'no responde (¿Docker parado?)' : e.message };
  } finally { await pool.end().catch(() => {}); }
}

async function apiEngineStatus(res) {
  try {
    const body = { driver: 'postgres', label: 'PostgreSQL + PostGIS', busy: await busyJobs(), locked: BACKENDS_LOCKED,
      postgres: await postgresStatus() };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// Runs a command and streams its output lines; resolves with the exit code.
function runStreaming(cmd, args, onLine, opts = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let buf = '';
    const feed = chunk => {
      buf += chunk.toString().replace(/\r(?!\n)/g, '\n');
      const lines = buf.split('\n'); buf = lines.pop();
      lines.map(l => l.trim()).filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', e => { onLine('✗ ' + e.message); resolve(-1); });
    child.on('close', code => { if (buf.trim()) onLine(buf.trim()); resolve(code); });
  });
}

const { dockerBin, dockerEnv } = require('./scripts/docker');

// Persists a setting in .env and in this process's environment (inherited by the scripts it runs).
function setEnvVar(name, value) {
  const file = path.join(ROOT, '.env');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${name}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${name}=${value}`) : `${name}=${value}\n` + text;
  fs.writeFileSync(file, text);
  process.env[name] = value;
}


// ── GPX store: status and live switch (Admin → Base de datos → Almacén de GPX) ─────
let switchingStorage = false;
const STORAGE_LABEL = { local: 'Carpeta local', s3: 'S3 (Garage)' };

async function storeStatus(driver) {
  if (driver === 's3' && !require('./config').S3.endpoint) return { configured: false, reachable: false };
  let store;
  try {
    store = driver === blob.driver ? blob : createBlob({ driver });
    await store.ping();
    return { configured: true, reachable: true, files: (await store.list()).length, where: store.where };
  } catch (e) {
    return { configured: true, reachable: false, where: store?.where, error: e.message };
  } finally { if (store && store !== blob) await store.close().catch(() => {}); }
}

async function apiStorageStatus(res) {
  try {
    const body = { driver: blob.driver, label: STORAGE_LABEL[blob.driver], busy: switchingStorage || await busyJobs(), locked: BACKENDS_LOCKED,
      local: await storeStatus('local'), s3: await storeStatus('s3') };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function apiStorageSwitch(req, res) {
  const { to } = await parseBody(req).catch(() => ({}));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const log = text => send({ type: text.startsWith('✗') ? 'error' : text.startsWith('⚠') ? 'warn' : 'log', text });
  const finish = code => { send({ type: 'done', code }); res.end(); };
  send({ type: 'start' });

  if (BACKENDS_LOCKED) { log('✗ ' + LOCKED_MSG); return finish(1); }
  if (!['local', 's3'].includes(to)) { log('✗ Almacén de destino no válido'); return finish(1); }
  if (to === blob.driver) { log(`✗ ${STORAGE_LABEL[to]} ya es el almacén en uso`); return finish(1); }
  if (switchingStorage) { log('✗ Ya hay un cambio en curso'); return finish(1); }
  if (await busyJobs()) { log('✗ Hay trabajos en cola o en marcha (Admin → Trabajos): espera a que terminen'); return finish(1); }
  if (!require('./config').S3.endpoint) { log('✗ Falta la configuración S3 en .env: ejecuta node scripts/storage-setup.js'); return finish(1); }

  switchingStorage = true;
  const from = blob.driver;
  appendLog('info', 'storage', `Cambio de almacén ${from} → ${to} iniciado`);
  try {
    log('1/3 Comprobando el almacén S3…');
    let s3 = await storeStatus('s3');
    if (!s3.reachable) {
      log(`⚠ S3 ${s3.error || 'no responde'}; intentando arrancarlo con docker compose…`);
      const code = await runStreaming(dockerBin(), ['compose', 'up', '-d', 'storage'], l => log('   ' + l), { env: dockerEnv() });
      if (code !== 0) throw new Error('No se pudo arrancar Docker. Abre Docker Desktop y vuelve a intentarlo.');
      for (let i = 0; i < 20 && !s3.reachable; i++) { await new Promise(r => setTimeout(r, 1500)); s3 = await storeStatus('s3'); }
      if (!s3.reachable) throw new Error('S3 no responde tras arrancar el contenedor');
    }
    log(`✓ S3 disponible (${s3.files} ficheros ahora)`);

    log(`2/3 Copiando ${STORAGE_LABEL[from]} → ${STORAGE_LABEL[to]} y comprobando cada fichero…`);
    const code = await runStreaming(process.execPath, [path.join(ROOT, 'scripts', 'blob-copy.js'), '--to', to], l => { if (!l.startsWith('…')) log('   ' + l); });
    if (code !== 0) throw new Error(code === 2 ? 'Faltan ficheros o no coinciden en el destino; se cancela el cambio' : 'La copia ha fallado; se cancela el cambio');

    log('3/3 Activando el nuevo almacén…');
    const next = createBlob({ driver: to });
    await next.ping();
    const old = blob;
    blob = next;
    setEnvVar('STORAGE_DRIVER', to);
    await old.close().catch(() => {});
    appendLog('info', 'storage', `Almacén cambiado a ${to}`);
    log(`✓ La aplicación usa ahora ${STORAGE_LABEL[to]}. Los ficheros de ${STORAGE_LABEL[from]} se conservan.`);
    finish(0);
  } catch (e) {
    appendLog('error', 'storage', `Cambio de almacén ${from} → ${to} fallido: ${e.message}`);
    log('✗ ' + e.message);
    log(`Se mantiene ${STORAGE_LABEL[from]}`);
    finish(1);
  } finally { switchingStorage = false; }
}

// Operations still tied to the SQLite file (legacy catalog-data.js export).
const SQLITE_ONLY = [/^\/api\/db\/export$/];
const isSqliteOnly = p => SQLITE_ONLY.some(re => re.test(p));

// ── Enrutador ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const _t0 = Date.now();
  const _origEnd = res.end.bind(res);
  res.end = function(...a) { const ms = Date.now() - _t0; if (ms > 80 && !String(res.getHeader('Content-Type')).includes('event-stream')) console.log(`[slow] ${ms}ms  ${method} ${pathname}`); return _origEnd(...a); };

  // Same-origin only: no CORS headers, and changes requested by another site are refused
  // (a page on another origin could otherwise send POST/DELETE to this server from the browser).
  if (!['GET', 'HEAD'].includes(method) && req.headers.origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!sameOrigin) { res.writeHead(403); return res.end('Cross-origin request refused'); }
  }
  if (repo.driver !== 'sqlite' && isSqliteOnly(pathname)) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Operación solo disponible con SQLite.' }));
  }
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/api/db/stats' && method === 'GET')
    return apiStats(res);


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

  const gpxMatch = pathname.match(/^\/api\/tracks\/(\d+)\/gpx$/);
  if (gpxMatch && method === 'GET')
    return apiDownloadGpx(res, parseInt(gpxMatch[1]), searchParams);

  // ── Track CRUD ────────────────────────────────────────────────────
  if (pathname === '/api/tags' && method === 'GET') {
    try {
      const tags = await repo.tags();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tags));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (pathname === '/api/catalog' && method === 'GET')
    return apiCatalog(req, res);

  if (pathname === '/api/tracks/recent-ids' && method === 'GET') {
    try {
      const ids = await repo.recentIds();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ids));
    } catch (e) { res.writeHead(500); res.end('[]'); }
    return;
  }

  if (pathname === '/api/tracks' && method === 'GET')
    return apiGetTracks(res);

  if (pathname === '/api/tracks/bulk-update' && method === 'POST')
    return apiBulkUpdate(req, res);

  const trackMoveMatch = pathname.match(/^\/api\/tracks\/(\d+)\/move$/);
  if (trackMoveMatch && method === 'POST')
    return apiMoveTrack(req, res, parseInt(trackMoveMatch[1]));

  const trackMatch = pathname.match(/^\/api\/tracks\/(\d+)$/);
  if (trackMatch && method === 'GET')
    return apiGetTrackById(res, parseInt(trackMatch[1]), searchParams.get('full') === '1');
  if (trackMatch && method === 'PATCH')
    return apiPatchTrack(req, res, parseInt(trackMatch[1]));
  if (trackMatch && method === 'DELETE')
    return apiDeleteTrack(res, parseInt(trackMatch[1]));

  if (pathname === '/api/tracks/bulk-delete' && method === 'POST')
    return apiBulkDelete(req, res);


  if (pathname === '/api/db/temp-files' && method === 'GET') {
    const srcParam = searchParams.get('src');
    const srcDir = srcParam ? path.resolve(srcParam) : null;
    return apiTempFiles(res, srcDir);
  }

  if (pathname === '/api/import/upload' && method === 'POST') {
    const rawName = (req.headers['x-filename'] || 'track.gpx').replace(/[^\w\s\-.()\[\]áéíóúÁÉÍÓÚñÑüÜ]/g, '_');
    const filename = rawName.toLowerCase().endsWith('.gpx') ? rawName : rawName + '.gpx';
    const tempDir  = path.join(ROOT, 'TracksGps', '_TEMP_');
    fs.mkdirSync(tempDir, { recursive: true });
    const dest = path.join(tempDir, filename);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    fs.writeFileSync(dest, Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, filename }));
  }

  if (pathname === '/api/import/wikiloc' && method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const url  = (body.url || '').trim();
    if (!url) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Missing url'})); }
    return apiRunScript(res, path.join(ROOT, 'scripts', 'wikiloc-import.js'), [url]);
  }

  if (pathname === '/api/import/komoot' && method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const url  = (body.url || '').trim();
    if (!url) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Missing url'})); }
    return apiRunScript(res, path.join(ROOT, 'scripts', 'komoot-import.js'), [url]);
  }

  if (pathname === '/api/db/import-temp' && method === 'POST') {
    const body  = await parseBody(req).catch(() => ({}));
    const force = body.force || searchParams.get('force') === '1';
    const files = Array.isArray(body.files) && body.files.length ? body.files : null;
    const src   = typeof body.src === 'string' && body.src.trim() ? body.src.trim() : null;
    const keep  = body.keep === true;
    const args  = [];
    if (force) args.push('--force');
    if (files) args.push('--files', files.join('|'));
    if (src)   args.push('--src', src);
    if (keep)  args.push('--keep');
    return apiRunScript(res, path.join(ROOT,'scripts','import-from-temp.js'), args);
  }


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

  if (pathname === '/api/db/osm-download' && (method === 'GET' || method === 'POST')) {
    return apiRunScript(res, path.join(ROOT, 'scripts', 'osm-download.js'), []);
  }

  if (pathname === '/api/db/osm-precache' && (method === 'GET' || method === 'POST')) {
    const force       = searchParams.get('force') === '1';
    const cacheOnly   = searchParams.get('cache-only') === '1';
    const enrichOnly  = searchParams.get('enrich-only') === '1';
    const missingOnly = searchParams.get('missing-only') === '1';
    const sierra      = searchParams.get('sierra');
    const args        = [];
    if (force)       args.push('--force');
    if (cacheOnly)   args.push('--cache-only');
    if (enrichOnly)  args.push('--enrich-only');
    if (missingOnly) args.push('--missing-only');
    if (sierra)      { args.push('--sierra'); args.push(sierra); }
    return apiRunScript(res, path.join(ROOT, 'scripts', 'osm-precache.js'), args);
  }

  // ── OSM settings ─────────────────────────────────────────────────
  const OSM_SETTINGS = path.join(ROOT, 'osm-settings.json');
  function readOsmSettings() {
    try { if (fs.existsSync(OSM_SETTINGS)) return JSON.parse(fs.readFileSync(OSM_SETTINGS, 'utf8')); } catch {}
    return { strategy: 'per-track', cacheTtlDays: 30 };
  }

  // ── OAuth Wikiloc ──────────────────────────────────────────────────
  if (pathname === '/auth/wikiloc' && method === 'GET') {
    const s = readOsmSettings();
    const clientId = s.wikiloc_client_id;
    if (!clientId) { res.writeHead(302, { Location: '/admin?wl-error=no-client-id#params' }); return res.end(); }
    const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    _oauthState = { state, ts: Date.now() };
    const qs = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: `http://localhost:${PORT}/auth/wikiloc/callback`,
      scope: 'trails',
      state,
    });
    res.writeHead(302, { Location: `https://www.wikiloc.com/oauth2/authorize?${qs}` });
    return res.end();
  }

  if (pathname === '/auth/wikiloc/callback' && method === 'GET') {
    const code  = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    if (error) { res.writeHead(302, { Location: `/admin?wl-error=${encodeURIComponent(error)}#params` }); return res.end(); }
    if (!_oauthState || _oauthState.state !== state || Date.now() - _oauthState.ts > 300000) {
      res.writeHead(302, { Location: '/admin?wl-error=state-mismatch#params' }); return res.end();
    }
    _oauthState = null;
    const s = readOsmSettings();
    try {
      const tr = await fetch('https://www.wikiloc.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code,
          redirect_uri: `http://localhost:${PORT}/auth/wikiloc/callback`,
          client_id: s.wikiloc_client_id, client_secret: s.wikiloc_client_secret,
        }).toString(),
      });
      const data = await tr.json();
      if (data.access_token) {
        const next = { ...s, wikiloc_token: data.access_token };
        if (data.refresh_token) next.wikiloc_refresh_token = data.refresh_token;
        fs.writeFileSync(OSM_SETTINGS, JSON.stringify(next, null, 2));
        appendLog('info', 'oauth', 'Wikiloc OAuth: token obtenido');
        res.writeHead(302, { Location: '/admin?wl-ok=1#params' });
      } else {
        appendLog('warn', 'oauth', `Wikiloc OAuth sin token: ${JSON.stringify(data)}`);
        res.writeHead(302, { Location: `/admin?wl-error=${encodeURIComponent(data.error || 'no-token')}#params` });
      }
    } catch (e) {
      appendLog('error', 'oauth', `Wikiloc OAuth callback error: ${e.message}`);
      res.writeHead(302, { Location: `/admin?wl-error=${encodeURIComponent(e.message)}#params` });
    }
    return res.end();
  }

  if (pathname === '/auth/wikiloc/disconnect' && method === 'POST') {
    const s = readOsmSettings();
    const next = { ...s };
    delete next.wikiloc_token; delete next.wikiloc_refresh_token;
    fs.writeFileSync(OSM_SETTINGS, JSON.stringify(next, null, 2));
    appendLog('info', 'oauth', 'Wikiloc: sesión desconectada');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/config/settings' && method === 'GET') {
    const s = readOsmSettings();
    const safe = { ...s };
    if (safe.wikiloc_token)         safe.wikiloc_token = '(configured)';
    if (safe.wikiloc_client_secret) safe.wikiloc_client_secret = '(configured)';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(safe));
  }

  if (pathname === '/api/config/settings' && method === 'PATCH') {
    try {
      const body = await parseBody(req);
      const current = readOsmSettings();
      const ALLOWED = ['wikiloc_token', 'wikiloc_client_id', 'wikiloc_client_secret'];
      const updates = {};
      for (const k of ALLOWED) {
        if (k in body) updates[k] = body[k] === '' ? undefined : body[k];
      }
      const next = { ...current };
      for (const [k, v] of Object.entries(updates)) {
        if (v === undefined) delete next[k]; else next[k] = v;
      }
      fs.writeFileSync(OSM_SETTINGS, JSON.stringify(next, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/config/osm-strategy' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(readOsmSettings()));
  }

  if (pathname === '/api/config/osm-strategy' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const valid = ['per-track', 'batch-sierra', 'local-osm'];
      if (!valid.includes(body.strategy)) {
        res.writeHead(400); return res.end(JSON.stringify({ error: 'estrategia inválida' }));
      }
      const settings = { ...readOsmSettings(), ...body };
      fs.writeFileSync(OSM_SETTINGS, JSON.stringify(settings, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...settings }));
    } catch(e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/admin/osm-cache' && method === 'GET') {
    const cacheDir = path.join(ROOT, 'data', 'osm-cache');
    const slugify = s => (s||'sin-zona').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
    try {
      // All groups from DB
      const db = sqlDb();
      const groups = await db.all(
        `SELECT COALESCE(sierra, province, 'sin-zona') AS group_key, CAST(COUNT(*) AS INTEGER) AS track_count
         FROM tracks WHERE sw_lat IS NOT NULL GROUP BY COALESCE(sierra, province, 'sin-zona') ORDER BY track_count DESC, COALESCE(sierra, province, 'sin-zona') ${db.BIN}`);
      const entries = groups.map(g => {
        const slug = slugify(g.group_key);
        const fp   = path.join(cacheDir, slug + '.json');
        if (!fs.existsSync(fp)) return { name: slug, label: g.group_key, trackCount: g.track_count, cached: false };
        const stat = fs.statSync(fp);
        const ts = stat.mtimeMs;
        return { name: slug, label: g.group_key, trackCount: g.track_count, cached: true,
                 size: stat.size, ts, ageHours: Math.round((Date.now() - ts) / 3600000) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(entries));
    } catch(e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/admin/osm-cache' && method === 'DELETE') {
    const cacheDir = path.join(ROOT, 'data', 'osm-cache');
    try {
      if (fs.existsSync(cacheDir)) {
        fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))
          .forEach(f => fs.unlinkSync(path.join(cacheDir, f)));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (pathname === '/api/admin/osm-local-status' && method === 'GET') {
    const pbfPath = path.join(ROOT, 'data', 'osm', 'spain-highways.osm.pbf');
    const exists  = fs.existsSync(pbfPath);
    const size    = exists ? fs.statSync(pbfPath).size : 0;
    const mtime   = exists ? fs.statSync(pbfPath).mtime : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ exists, size, mtime }));
  }

  // ── Config routes ────────────────────────────────────────────────
  if (pathname === '/api/config/activity-counts' && method === 'GET') {
    const db = sqlDb();
    const rows = await db.all(`SELECT activity, CAST(COUNT(*) AS INTEGER) AS cnt FROM tracks WHERE activity IS NOT NULL GROUP BY activity ORDER BY cnt DESC, activity ${db.BIN}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.fromEntries(rows.map(r => [r.activity, r.cnt]))));
  }
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

  // ── Log routes ───────────────────────────────────────────────────
  if (pathname === '/api/admin/logs/list' && method === 'GET') {
    try {
      const files = fs.readdirSync(LOGS_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort().reverse()
        .map(f => f.replace(/\.log$/, ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); }
    return;
  }

  if (pathname === '/api/admin/logs' && method === 'GET') {
    try {
      const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const file = logFilePath(date);
      const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const lines = content.trim().split('\n').filter(Boolean);
      const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return { ts: null, level: 'raw', op: '', msg: l }; } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(parsed));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (pathname === '/api/admin/logs/download' && method === 'GET') {
    try {
      const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const file = logFilePath(date);
      const content = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="operations-${date}.log"`,
      });
      res.end(content);
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (pathname === '/api/admin/logs/clear' && method === 'POST') {
    try {
      const date = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(logFilePath(date), '');
      appendLog('info', 'server', 'Log limpiado manualmente');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // ── Admin routes ─────────────────────────────────────────────────
  if (pathname === '/admin' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'admin.html'), req);

  if (pathname === '/api/admin/db-engine' && method === 'GET') return apiEngineStatus(res);
  if (pathname === '/api/admin/storage' && method === 'GET') return apiStorageStatus(res);
  if (pathname === '/api/jobs' && method === 'GET') return apiJobs(res, searchParams);
  const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)(?:\/(stream|cancel|retry))?$/);
  if (jobMatch && jobMatch[2] === 'stream' && method === 'GET') return streamJob(res, parseInt(jobMatch[1]));
  if (jobMatch && ['cancel', 'retry'].includes(jobMatch[2]) && method === 'POST') return apiJobAction(res, parseInt(jobMatch[1]), jobMatch[2]);
  if (jobMatch && !jobMatch[2] && method === 'GET') {
    const job = await jobQueue().get(parseInt(jobMatch[1]));
    res.writeHead(job ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(job ? { ...job, label: JOBS[job.type]?.label || job.type } : { error: 'Not found' }));
  }
  if (pathname === '/api/admin/storage/switch' && method === 'POST') return apiStorageSwitch(req, res);

  if (pathname === '/api/admin/version' && method === 'GET') {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: pkg.version, name: pkg.name, db: repo.driver, storage: blob.driver }));
    return;
  }

  if (pathname === '/api/admin/stats' && method === 'GET')
    return apiAdminStats(res);
  if (pathname === '/api/admin/backup' && method === 'POST')
    return apiAdminBackup(res);
  if (pathname === '/api/admin/backups' && method === 'GET')
    return apiAdminBackups(res);
  if (pathname === '/api/admin/backup-config' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(readBackupConfig()));
  }
  if (pathname === '/api/admin/backup-config' && method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const cfg = { ...readBackupConfig(), ...body };
    writeBackupConfig(cfg);
    pruneBackups(cfg.maxKeep || 10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
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
    return serveStatic(res, path.join(ROOT, 'editor.html'), req);

  if (pathname === '/config' && method === 'GET') {
    const qs = new URL(req.url, 'http://x').search;
    res.writeHead(302, { Location: `/admin${qs}#${/wl-/.test(qs) ? 'params' : 'activities'}` });
    return res.end();
  }

  if (pathname === '/track' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'track.html'), req);

  if (pathname === '/trazar' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'trazar.html'), req);
  if (pathname === '/compare' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'compare.html'), req);

  if (pathname === '/api/export/folders' && method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const dest = typeof body.dest === 'string' ? body.dest.trim() : '';
    if (!dest) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Falta el destino' })); }
    const args = ['--dest', dest];
    if (Array.isArray(body.ids) && body.ids.length) args.push('--ids', body.ids.map(Number).filter(Boolean).join(','));
    return apiRunScript(res, path.join(ROOT, 'scripts', 'export-folders.js'), args);
  }
  if (pathname === '/api/db/migrate-store' && method === 'POST') {
    return apiRunScript(res, path.join(ROOT, 'scripts', 'migrate-store.js'), searchParams.get('dry') === '1' ? ['--dry-run'] : []);
  }

  if (pathname === '/api/db/extract-urls' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    return apiRunScript(res, path.join(ROOT,'scripts','extract-urls.js'), force ? ['--force'] : []);
  }

  if (pathname === '/api/fs/dirs' && method === 'GET') {
    const reqPath = searchParams.get('path') || ROOT;
    try {
      const abs = path.resolve(reqPath);
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
      const files = entries
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.gpx'))
        .map(e => ({ name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
      const parentAbs = path.dirname(abs);
      const parent = parentAbs !== abs ? parentAbs : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ current: abs, parent, dirs, files }));
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/open-folder' && method === 'GET') {
    const rel = searchParams.get('path') || '';
    const abs = path.normalize(path.join(ROOT, rel));
    const folder = path.dirname(abs);
    if (!folder.startsWith(path.join(ROOT, 'TracksGps'))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const { spawn } = require('child_process');
    spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }).unref();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Static files: only the front end (never .env, data/, settings or server code)
  let filePath = path.normalize(path.join(ROOT, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!filePath.startsWith(ROOT + path.sep) || !isPublicFile(path.relative(ROOT, filePath).split(path.sep).join('/'))) {
    res.writeHead(404); res.end('Not found'); return;
  }
  serveStatic(res, filePath, req);
});

// HOST=0.0.0.0 in the container; locally only loopback.
const HOST = process.env.HOST || '127.0.0.1';
if (!process.env.HOST) {
  // Browsers resolve "localhost" to ::1 first; without an IPv6 listener every connection waits for the fallback.
  const server6 = http.createServer((req, res) => server.emit('request', req, res));
  server6.on('error', () => {});
  server6.listen(PORT, '::1');
}

// docker stop sends SIGTERM: close the database pool and the store cleanly
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    server.close();
    Promise.allSettled([worker ? worker.stop() : null]).then(() => Promise.allSettled([repo.close(), blob.close()])).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Run schema migrations before serving
const ready = require('./repo/pg-migrate').migrate(repo.pool, console.log);
ready.catch(e => { console.error('✗ Migración de PostgreSQL: ' + e.message); process.exit(1); });

ready.then(() => server.listen(PORT, HOST, () => {
  if (worker) { worker.start(); console.log(`  Worker integrado: ${worker.id}`); }
  const url = `http://localhost:${PORT}`;
  console.log(`\n  GPX Library  →  ${url}\n`);
  appendLog('info', 'server', `Servidor iniciado en puerto ${PORT}`);
  const { exec } = require('child_process');
  const open = process.platform === 'win32' ? `start ${url}` : `open ${url}`;
  if (!process.env.NO_OPEN) exec(open);
  // Daily auto-backup on startup if none exists for today
  setImmediate(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      const hasTodayBackup = listBackupFiles().some(f => f.name.includes(today));
      if (!hasTodayBackup) {
        console.log('  Auto-backup diario...');
        const gz  = await createBackupFile();
        const cfg = readBackupConfig();
        pruneBackups(cfg.maxKeep || 10);
        console.log(`  ✓ Auto-backup: ${path.basename(gz)}`);
      }
    } catch (e) { console.error('  ✗ Auto-backup:', e.message); }
  });
}));
