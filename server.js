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
const { applyGpxMetadata, buildGpx, metaFromTrack, parseGpx, computeTimes, sampleEvenly,
        DEFAULT_CONFIG: GAMI_DEFAULTS, mergeConfig, validateConfig, multiDayInfo, computeAchievements } = require('./domain');
const { getRepo, createRepo } = require('./repo');
const { EDITABLE_FIELDS } = require('./repo/columns');
const { openSql } = require('./repo/sql');
const { createToken, setCookie, clearCookie, authMiddleware, requireAuth, requireAdmin, hashPassword, checkPassword } = require('./auth');
// Engine-neutral SQL on the active engine (shares the repository's Postgres pool; never closed here).
const sqlDb = () => openSql({ pool: repo.pool });
let repo = getRepo();   // reassigned when the engine is switched from Admin
const { downloadName, readTrackFile, deleteTrackFile, gpxText } = require('./scripts/store');
const { createBlob } = require('./blob');
// Store of the original GPX files (local folder or S3), swappable like `repo`.
let blob = createBlob();

const PORT = parseInt(process.env.PORT || '8080');
const ROOT = __dirname;
const PHOTOS_DIR = require('./config').PHOTOS_DIR;   // track photos (own Docker volume in prod)

let _oauthState = null; // { state, ts } — CSRF token para el flujo OAuth

// ── Operations log ─────────────────────────────────────────────────
const { LOGS_DIR, logFilePath, appendLog } = require('./scripts/applog');

const J = { 'Content-Type': 'application/json' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.gpx':  'application/gpx+xml',
  '.woff2':'font/woff2',
};

// ── Archivos estáticos ─────────────────────────────────────────────
// Public: the pages and styles at the root, the browser scripts listed here and assets/.
const PUBLIC_JS = new Set(['visor.js', 'theme.js', 'import-ui.js', 'shared.css', 'perfil.js', 'subir.js', 'icons.js']);
function isPublicFile(rel) {
  if (rel.split('/').some(s => s.startsWith('.'))) return false;
  if (rel.startsWith('assets/')) return true;
  if (rel.includes('/')) return false;
  const ext = path.extname(rel).toLowerCase();
  return ext === '.html' || ext === '.css' || PUBLIC_JS.has(rel);
}

// ── Estado vivo de la cuenta (rol / activo), con caché corta ───────
const _liveUsers = new Map();   // id → { at, row }
async function liveUser(id) {
  const hit = _liveUsers.get(id);
  if (hit && Date.now() - hit.at < 15000) return hit.row;
  let row;
  try { row = (await sqlDb().get('SELECT username, role, active FROM users WHERE id = ?', [id])) || null; }
  catch { return hit ? hit.row : null; }   // DB hiccup: keep the last known state
  _liveUsers.set(id, { at: Date.now(), row });
  return row;
}

// ── Permisos por rol ───────────────────────────────────────────────
// Non-admin users: viewer + search, track detail, compare, route drawing and their own profile.
const ADMIN_PAGES = new Set(['/admin', '/config', '/admin.html']);
const USER_PAGES  = new Set(['/', '/track', '/trazar', '/compare', '/perfil', '/editor', '/editor.html', '/subir', '/subir.html']);
const USER_API = [
  ['GET',    /^\/api\/(catalog|tags|geo|tracks)$/],
  ['GET',    /^\/api\/config\/(activities|sierras|provinces)$/],
  ['GET',    /^\/api\/tracks\/\d+(\/gpx|\/export-gpx)?$/],
  ['POST',   /^\/api\/tracks\/export-gpx$/],
  ['POST',   /^\/api\/tracks\/bulk-delete$/],
  ['POST',   /^\/api\/tracks\/bulk-update$/],
  ['PATCH',  /^\/api\/tracks\/\d+$/],
  ['POST',   /^\/api\/tracks\/\d+\/move$/],
  ['DELETE', /^\/api\/tracks\/\d+$/],
  ['POST',   /^\/api\/import\/upload$/],
  ['POST',   /^\/api\/db\/import-temp$/],
  ['GET',    /^\/api\/tracks\/\d+\/photos$/],
  ['POST',   /^\/api\/tracks\/\d+\/photos$/],
  ['GET',    /^\/api\/photos\/\d+$/],
  ['DELETE', /^\/api\/photos\/\d+$/],
  ['PATCH',  /^\/api\/tracks\/\d+\/cover$/],
  ['GET',    /^\/api\/tracks\/\d+\/days$/],
  ['GET',    /^\/api\/activity-images\/[\w.-]+$/],
  ['GET',    /^\/api\/activity-icons\/[\w.-]+$/],
  ['GET',    /^\/api\/lists(\/shared)?$/],
  ['POST',   /^\/api\/lists$/],
  ['PATCH',  /^\/api\/lists\/\d+$/],
  ['DELETE', /^\/api\/lists\/\d+$/],
  ['GET',    /^\/api\/lists\/\d+\/tracks$/],
  ['POST',   /^\/api\/lists\/\d+\/tracks$/],
  ['DELETE', /^\/api\/lists\/\d+\/tracks\/\d+$/],
  ['GET',    /^\/api\/lists\/\d+\/shares$/],
  ['POST',   /^\/api\/lists\/\d+\/shares$/],
  ['DELETE', /^\/api\/lists\/\d+\/shares\/\d+$/],
];
function userMayAccess(pathname, method) {
  if (ADMIN_PAGES.has(pathname)) return false;
  if (USER_PAGES.has(pathname)) return true;
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/'))
    return USER_API.some(([m, re]) => (m === method || (m === 'GET' && method === 'HEAD')) && re.test(pathname));
  return true;   // static files: still filtered by isPublicFile() at the end
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
const { JOBS, IMPORT_TYPES, summarize } = require('./queue/jobs');
const jobQueue = () => createQueue(sqlDb());

const worker = process.env.EMBEDDED_WORKER === '0' ? null : createWorker({
  getQueue: jobQueue,
  isPaused: () => false,
  onFinish: (job, code, lines) => {
    appendLog(code === 0 ? 'info' : 'error', job.type, `${job.type} ${code === 0 ? 'completado' : code === 130 ? 'cancelado' : 'fallido'}`,
      { job: job.id, ...summarize(lines, code) });
    if (code === 0) {
      invalidateCatalogCache();
      if (IMPORT_TYPES.has(job.type)) jobQueue().enqueue('export-folders', {}).catch(() => {});
    }
  },
});

async function apiRunScript(res, scriptPath, args = [], user = null) {
  const type = path.basename(scriptPath, '.js');
  try {
    if (!JOBS[type]) throw new Error(`Tipo de trabajo desconocido: ${type}`);
    const payload = { args };
    if (user) payload.user = { id: user.sub, username: user.username };
    const job = await jobQueue().enqueue(type, payload, { maxAttempts: JOBS[type].maxAttempts || 1 });
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

async function buildCatalog(ownerId) {
  const tracks = await repo.catalogTracks({ ownerId });
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
      difficulty:    t.difficulty   ?? null,   // grade chosen by the user (0–5), else derived from the IBP
      hasOsm:        !!(t.road_types && t.road_types !== '{}'),
      movingTime:    t.moving_time  || null,
      stoppedTime:   t.stopped_time || null,
      circular:      !!t.circular,
      owner_id:      t.owner_id       || null,
      owner_username: t.owner_username || null,
      visibility:    t.visibility     || 'public',
      cover:         t.cover_photo_id ? `/api/photos/${t.cover_photo_id}?size=thumb` : null,
      points,
    });
  }
  return JSON.stringify(catalog);
}

// Catalog cache: keyed by ownerId (null = public only, N = public + own private)
let _catalogDataVersion = null;
const _catalogCacheMap = new Map(); // ownerId → { data, etag, size }
function invalidateCatalogCache() { _catalogDataVersion = null; _catalogCacheMap.clear(); }

async function apiCatalog(req, res) {
  try {
    const ownerId = req.user ? req.user.sub : null;
    const version = await jobQueue().dataVersion().catch(() => null);
    if (version !== _catalogDataVersion) { _catalogDataVersion = version; _catalogCacheMap.clear(); }
    if (!_catalogCacheMap.has(ownerId)) {
      const data = await buildCatalog(ownerId);
      _catalogCacheMap.set(ownerId, { data, etag: `"cat-${ownerId}-${Date.now().toString(36)}"` });
      console.log(`[catalog] built for user=${ownerId}: ${Math.round(Buffer.byteLength(data)/1024)}KB`);
    }
    const { data, etag } = _catalogCacheMap.get(ownerId);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ETag: etag });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── API /tracks ───────────────────────────────────────────────────
async function apiGetTracks(res, viewerId = null, mineOnly = false) {
  try {
    let tracks = await repo.listTracks();
    if (viewerId != null) {
      // mineOnly (editor): just this user's tracks. Otherwise (compare, trazar): public + own private.
      const where = mineOnly ? 'owner_id = ?' : "visibility = 'public' OR owner_id = ?";
      const visible = new Set((await sqlDb().all(`SELECT id FROM tracks WHERE ${where}`, [viewerId])).map(r => r.id));
      tracks = tracks.filter(t => visible.has(t.id));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tracks));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}


async function deleteTrackById(id) {
  // Photo rows go away with the track (FK cascade); their files must be removed by hand
  const photos = await sqlDb().all('SELECT filename, thumb_filename FROM track_photos WHERE track_id = ?', [id]).catch(() => []);
  const file = await repo.deleteTrack(id);
  if (!file) return { ok: false, error: 'Not found' };
  for (const p of photos) for (const f of [p.filename, p.thumb_filename]) if (f) { try { fs.unlinkSync(path.join(PHOTOS_DIR, f)); } catch {} }
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

// ── Gamificación: configuración editable (app_settings 'gamification') + cálculo ──
async function getSetting(key) {
  const r = await sqlDb().get('SELECT value FROM app_settings WHERE key = ?', [key]).catch(() => null);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}
async function gamificationConfig() { return mergeConfig(await getSetting('gamification')); }
// Completed (non-planned) tracks of a user, in the shape computeAchievements expects
async function userCompletedTracks(uid) {
  return sqlDb().all(
    `SELECT id, name, activity, distance, elevation_gain, moving_time, time_segments, days_declared, province, circular, date
     FROM tracks WHERE owner_id = ? AND NOT planned`, [uid]);
}
async function userAchievements(uid, cfg) {
  const db = sqlDb();
  const photos = (await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM track_photos WHERE owner_id = ?', [uid])).n;
  const lists  = (await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM user_lists WHERE owner_id = ?', [uid])).n;
  return computeAchievements(await userCompletedTracks(uid), { photos, lists }, cfg);
}

// Access level of a user to a list: 'owner' | 'editor' | 'viewer' | null (+ exists flag).
async function listAccess(listId, userId, isAdmin = false) {
  const l = await sqlDb().get('SELECT owner_id, visibility FROM user_lists WHERE id = ?', [listId]);
  if (!l) return { role: null, exists: false };
  if (l.owner_id === userId) return { role: 'owner', exists: true, list: l };
  if (isAdmin) return { role: 'owner', exists: true, list: l };
  const share = await sqlDb().get('SELECT can_edit FROM user_list_shares WHERE list_id = ? AND user_id = ?', [listId, userId]);
  if (share) return { role: share.can_edit ? 'editor' : 'viewer', exists: true, list: l };
  if (l.visibility === 'public') return { role: 'viewer', exists: true, list: l };
  return { role: null, exists: true, list: l };
}

// Coerces and checks the numeric editable fields in place; returns an error message or null.
//   days_declared: NULL auto · 0 several (no number) · 1 one day · N days
//   difficulty:    NULL from IBP · 0 Muy fácil … 5 Extrema
function normalizeTrackFields(f) {
  const int = (k, min, max, msg) => {
    if (!(k in f)) return null;
    f[k] = f[k] === null || f[k] === '' ? null : Number(f[k]);
    return f[k] === null || (Number.isInteger(f[k]) && f[k] >= min && f[k] <= max) ? null : msg;
  };
  return int('days_declared', 0, 365, 'Días no válidos') || int('difficulty', 0, 5, 'Dificultad no válida');
}

// True if the track belongs to ownerId (used to gate non-admin edits).
async function ownsTrack(id, ownerId) {
  const t = await sqlDb().get('SELECT 1 FROM tracks WHERE id = ? AND owner_id = ?', [id, ownerId]);
  return !!t;
}
// For a non-admin (ownerId set), keep only the ids they own; admins (null) keep all.
async function ownedOnly(ids, ownerId) {
  if (ownerId == null || !ids.length) return ids;
  const rows = await sqlDb().all(`SELECT id FROM tracks WHERE owner_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ownerId, ...ids]);
  return rows.map(r => r.id);
}

async function apiBulkDelete(req, res, ownerId = null) {
  try {
    const body = await parseBody(req);
    let ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) { res.writeHead(400); res.end('No ids'); return; }
    ids = await ownedOnly(ids, ownerId);
    if (!ids.length) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'No puedes borrar rutas que no son tuyas' })); }
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
    const bad = normalizeTrackFields(body);
    if (bad) { res.writeHead(400, J); return res.end(JSON.stringify({ error: bad })); }
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

async function apiBulkUpdate(req, res, ownerId = null) {
  try {
    const body = await parseBody(req);
    const { fields, notesAppend } = body;
    let { ids } = body;
    if (!Array.isArray(ids) || !ids.length || !fields) {
      res.writeHead(400); res.end('Invalid body'); return;
    }
    const editFields = Object.keys(fields).filter(k => EDITABLE_FIELDS.has(k) && fields[k] !== undefined);
    if (!editFields.length) { res.writeHead(400); res.end('No fields'); return; }
    const bad = normalizeTrackFields(fields);
    if (bad) { res.writeHead(400, J); return res.end(JSON.stringify({ error: bad })); }
    ids = await ownedOnly(ids.map(Number).filter(Boolean), ownerId);
    if (!ids.length) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'No puedes editar rutas que no son tuyas' })); }
    await repo.bulkUpdate(ids, fields, !!notesAppend);
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
    const body = await parseBody(req);
    // Callers that don't send the icon keep the current one
    if (table === 'config_activities' && body.icon === undefined)
      body.icon = (await sqlDb().get('SELECT icon FROM config_activities WHERE id = ?', [id]))?.icon ?? null;
    const row = await repo.updateConfig(table, id, body);
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
    appendLog('info', 'backup', `Copia de seguridad creada: ${path.basename(gz)}`, { size });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: path.basename(gz), size }));
  } catch (e) {
    appendLog('error', 'backup', 'Copia de seguridad fallida', { error: e.message });
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

// ── Deployment lock (Admin cannot change engine/store in docker-compose) ───────
const BACKENDS_LOCKED = !!process.env.LOCK_BACKENDS;
const LOCKED_MSG = 'Fijado por el despliegue (docker-compose): cámbialo en su configuración';

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


// ── GPX store status (Admin → Base de datos) ────────────────────────────────────

async function storeStatus() {
  if (!require('./config').S3.endpoint) return { configured: false, reachable: false };
  try {
    await blob.ping();
    return { configured: true, reachable: true, files: (await blob.list()).length, where: blob.where };
  } catch (e) {
    return { configured: true, reachable: false, where: blob.where, error: e.message };
  }
}

async function apiStorageStatus(res) {
  try {
    const body = { s3: await storeStatus(), busy: await busyJobs(), locked: BACKENDS_LOCKED };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Sincronización local (Admin → Base de datos) ────────────────────────────────

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
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Auth ──────────────────────────────────────────────────────────
  authMiddleware(req);
  // The token carries the role at login time: use the live account state so that deactivating a
  // user or changing their role from Admin takes effect at once.
  if (req.user) {
    const live = await liveUser(req.user.sub);
    if (!live || !live.active) { clearCookie(res); req.user = null; }
    else { req.user.role = live.role; req.user.username = live.username; }
  }

  // Login page and auth endpoints are public
  if (pathname === '/login') return serveStatic(res, path.join(ROOT, 'login.html'), req);

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await parseBody(req);
    const db = sqlDb();
    const login = String(body.username || '').trim().toLowerCase();
    const user = await db.get('SELECT id, username, email, password_hash, role, active FROM users WHERE lower(username) = ? OR lower(email) = ?', [login, login]);
    if (!user || !user.active || !checkPassword(body.password || '', user.password_hash)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Usuario o contraseña incorrectos' }));
    }
    const token = createToken(user);
    setCookie(res, token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: user.id, username: user.username, role: user.role }));
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    clearCookie(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    if (!req.user) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'No autenticado' })); }
    const u = await sqlDb().get('SELECT display_name, avatar_key FROM users WHERE id = ?', [req.user.sub]).catch(() => null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: req.user.sub, username: req.user.username, role: req.user.role,
      display_name: u?.display_name || null,
      avatar_url: u?.avatar_key ? `/api/profile/avatar/${encodeURIComponent(u.avatar_key)}` : null }));
  }

  // ── Admin: gestión de usuarios ────────────────────────────────────
  if (pathname === '/api/admin/users' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const db = sqlDb();
    const users = await db.all(`
      SELECT u.id, u.username, u.email, u.display_name, u.avatar_key, u.role, u.active,
             to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created_at,
             CAST(COUNT(t.id) AS INTEGER) AS track_count,
             CAST(COUNT(t.id) FILTER (WHERE t.visibility = 'private') AS INTEGER) AS private_count,
             ROUND(CAST(COALESCE(SUM(t.distance), 0) AS NUMERIC), 1) AS total_km,
             CAST((SELECT COUNT(*) FROM user_lists l WHERE l.owner_id = u.id) AS INTEGER) AS list_count
      FROM users u LEFT JOIN tracks t ON t.owner_id = u.id
      GROUP BY u.id ORDER BY u.id`);
    const orphan = await db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM tracks WHERE owner_id IS NULL');
    for (const u of users) {
      u.avatar_url = u.avatar_key ? `/api/profile/avatar/${encodeURIComponent(u.avatar_key)}` : null;
      delete u.avatar_key;
    }
    res.writeHead(200, J);
    return res.end(JSON.stringify({ users, orphanTracks: orphan.n, me: req.user.sub }));
  }

  // Change the owner (and optionally the visibility) of several tracks at once
  if (pathname === '/api/admin/tracks/owner' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await parseBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    const orphans = body.orphans === true;   // every track without owner
    if (!ids.length && !orphans) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Sin rutas' })); }
    const owner = body.owner_id == null || body.owner_id === '' ? null : parseInt(body.owner_id);
    const db = sqlDb();
    if (owner != null && !(await db.get('SELECT 1 FROM users WHERE id = ?', [owner]))) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Usuario no encontrado' })); }
    const sets = ['owner_id = ?']; const vals = [owner];
    if (body.visibility === 'public' || body.visibility === 'private') { sets.push('visibility = ?'); vals.push(body.visibility); }
    const where = orphans ? 'owner_id IS NULL' : `id IN (${ids.map(() => '?').join(',')})`;
    if (!orphans) vals.push(...ids);
    const r = await db.get(`WITH up AS (UPDATE tracks SET ${sets.join(', ')} WHERE ${where} RETURNING 1) SELECT CAST(COUNT(*) AS INTEGER) AS n FROM up`, vals);
    invalidateCatalogCache();
    appendLog('info', 'users', `Dueño cambiado en ${r.n} ruta(s)`, { owner, by: req.user.username });
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, updated: r.n }));
  }

  if (pathname === '/api/admin/users' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await parseBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const email    = String(body.email || '').trim().toLowerCase();
    const { password, display_name } = body;
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!username || !email || !password) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Faltan campos obligatorios' })); }
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Usuario: 2–32 caracteres (letras, números, punto, guion)' })); }
    if (password.length < 6) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'La contraseña debe tener al menos 6 caracteres' })); }
    const db = sqlDb();
    try {
      const hash = hashPassword(password);
      const row = await db.get('INSERT INTO users (username, email, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?) RETURNING id, username, email, role', [username, email, hash, role, (display_name || '').trim() || null]);
      appendLog('info', 'users', `Usuario creado: ${username}`, { role, by: req.user.username });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(row));
    } catch (e) {
      const dup = e.message.includes('unique') || e.message.includes('duplicate');
      res.writeHead(dup ? 409 : 500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: dup ? 'Nombre de usuario o email ya existe' : e.message }));
    }
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && method === 'PATCH') {
    if (!requireAdmin(req, res)) return;
    const uid = parseInt(userMatch[1]);
    const body = await parseBody(req);
    const db = sqlDb();
    const fail = (code, error) => { res.writeHead(code, J); res.end(JSON.stringify({ error })); };
    const target = await db.get('SELECT id, role, active FROM users WHERE id = ?', [uid]);
    if (!target) return fail(404, 'Usuario no encontrado');
    const self = uid === req.user.sub;
    if (self && body.active === false) return fail(400, 'No puedes desactivar tu propia cuenta');
    if (self && body.role && body.role !== 'admin') return fail(400, 'No puedes quitarte el rol de administrador');
    if (target.role === 'admin' && ((body.role && body.role !== 'admin') || body.active === false)) {
      const { n } = await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE role = 'admin' AND active AND id <> ?", [uid]);
      if (!n) return fail(400, 'Debe quedar al menos un administrador activo');
    }
    const updates = [];
    const vals = [];
    if (body.active !== undefined) { updates.push('active = ?'); vals.push(body.active ? 1 : 0); }
    if (body.role) { updates.push('role = ?'); vals.push(body.role === 'admin' ? 'admin' : 'user'); }
    if (body.password) {
      if (String(body.password).length < 6) return fail(400, 'La contraseña debe tener al menos 6 caracteres');
      updates.push('password_hash = ?'); vals.push(hashPassword(body.password));
    }
    if (body.email !== undefined) {
      const email = String(body.email).trim().toLowerCase();
      if (!email) return fail(400, 'El email es obligatorio');
      updates.push('email = ?'); vals.push(email);
    }
    if (body.display_name !== undefined) { updates.push('display_name = ?'); vals.push(String(body.display_name).trim() || null); }
    if (!updates.length) return fail(400, 'Nada que actualizar');
    updates.push('updated_at = NOW()');
    vals.push(uid);
    try {
      await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);
    } catch (e) {
      if (e.code === '23505') return fail(409, 'Ese email ya lo usa otro usuario');
      throw e;
    }
    _liveUsers.delete(uid);
    invalidateCatalogCache();
    appendLog('info', 'users', `Usuario modificado: id=${uid}`, { fields: Object.keys(body).filter(k => k !== 'password').concat(body.password ? ['password'] : []), by: req.user.username });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Delete a user: their tracks go to another user (reassign_to) or are left without owner
  if (userMatch && method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    const uid = parseInt(userMatch[1]);
    const db = sqlDb();
    const fail = (code, error) => { res.writeHead(code, J); res.end(JSON.stringify({ error })); };
    if (uid === req.user.sub) return fail(400, 'No puedes borrar tu propia cuenta');
    const target = await db.get('SELECT id, username, role, avatar_key FROM users WHERE id = ?', [uid]);
    if (!target) return fail(404, 'Usuario no encontrado');
    if (target.role === 'admin') {
      const { n } = await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE role = 'admin' AND active AND id <> ?", [uid]);
      if (!n) return fail(400, 'Debe quedar al menos un administrador activo');
    }
    const to = searchParams.get('reassign_to') ? parseInt(searchParams.get('reassign_to')) : null;
    if (to === uid) return fail(400, 'No puedes reasignar las rutas al mismo usuario');
    if (to != null && !(await db.get('SELECT 1 FROM users WHERE id = ?', [to]))) return fail(404, 'Usuario destino no encontrado');
    let moved = 0;
    await db.tx(async t => {
      moved = (await t.get('WITH up AS (UPDATE tracks SET owner_id = ? WHERE owner_id = ? RETURNING 1) SELECT CAST(COUNT(*) AS INTEGER) AS n FROM up', [to, uid])).n;
      await t.run('DELETE FROM users WHERE id = ?', [uid]);   // user_lists cascade
    });
    if (target.avatar_key) blob.del(target.avatar_key).catch(() => {});
    _liveUsers.delete(uid);
    invalidateCatalogCache();
    appendLog('info', 'users', `Usuario borrado: ${target.username}`, { tracks: moved, reassign_to: to, by: req.user.username });
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, tracks: moved }));
  }

  // ── Perfil del usuario autenticado ───────────────────────────────
  if (pathname === '/perfil') return serveStatic(res, path.join(ROOT, 'perfil.html'), req);

  if (pathname === '/api/profile/me' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const db = sqlDb();
    const u = await db.get(
      'SELECT id, username, email, display_name, bio, avatar_key, role, to_char(created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD\') AS created_at FROM users WHERE id = ?',
      [req.user.sub]);
    if (!u) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Usuario no encontrado' })); }
    const avatarUrl = u.avatar_key ? `/api/profile/avatar/${encodeURIComponent(u.avatar_key)}` : null;
    res.writeHead(200, J);
    return res.end(JSON.stringify({ ...u, avatar_url: avatarUrl }));
  }

  if (pathname === '/api/profile/me' && method === 'PATCH') {
    if (!requireAuth(req, res)) return;
    const body = await parseBody(req);
    const db = sqlDb();
    const updates = []; const vals = [];
    if (body.display_name !== undefined) { updates.push('display_name = ?'); vals.push(body.display_name || null); }
    if (body.bio !== undefined)          { updates.push('bio = ?');          vals.push(body.bio || null); }
    if (!updates.length) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Nada que actualizar' })); }
    updates.push('updated_at = NOW()'); vals.push(req.user.sub);
    await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/profile/password' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await parseBody(req);
    const { current, next } = body;
    if (!current || !next || next.length < 6) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Contraseña inválida (mínimo 6 caracteres)' })); }
    const db = sqlDb();
    const u = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.sub]);
    if (!u || !checkPassword(current, u.password_hash)) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Contraseña actual incorrecta' })); }
    await db.run('UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?', [hashPassword(next), req.user.sub]);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/profile/avatar' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await parseBody(req);
    const { data: b64, mime: mimeType } = body;
    if (!b64 || !mimeType) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Faltan datos de imagen' })); }
    const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 2 * 1024 * 1024) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'La imagen no puede superar 2 MB' })); }
    const db = sqlDb();
    const u = await db.get('SELECT avatar_key FROM users WHERE id = ?', [req.user.sub]);
    if (u && u.avatar_key) { try { await blob.del(u.avatar_key); } catch {} }
    const newKey = `avatars/${req.user.sub}-${Date.now()}${ext}`;
    await blob.put(newKey, buf);
    await db.run('UPDATE users SET avatar_key = ?, updated_at = NOW() WHERE id = ?', [newKey, req.user.sub]);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, avatar_url: `/api/profile/avatar/${encodeURIComponent(newKey)}` }));
  }

  const avatarMatch = pathname.match(/^\/api\/profile\/avatar\/(.+)$/);
  if (avatarMatch && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const key = decodeURIComponent(avatarMatch[1]);
    const buf = await blob.get(key).catch(() => null);
    if (!buf) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(key).toLowerCase();
    const ct = MIME[ext] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'max-age=86400' });
    return res.end(buf);
  }

  if (pathname === '/api/profile/tracks' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const db = sqlDb();
    const tracks = await db.all(
      `SELECT id, name, activity, sierra, date, distance, elevation_gain, tags, visibility, planned,
              to_char(imported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS imported_at
       FROM tracks WHERE owner_id = ? ORDER BY date DESC NULLS LAST, name COLLATE "C" ASC, id`,
      [req.user.sub]);
    res.writeHead(200, J); return res.end(JSON.stringify(tracks));
  }

  const profileTrackMatch = pathname.match(/^\/api\/profile\/tracks\/(\d+)\/visibility$/);
  if (profileTrackMatch && method === 'PATCH') {
    if (!requireAuth(req, res)) return;
    const tid = parseInt(profileTrackMatch[1]);
    const body = await parseBody(req);
    const vis = body.visibility === 'private' ? 'private' : 'public';
    const db = sqlDb();
    const t = await db.get('SELECT owner_id FROM tracks WHERE id = ?', [tid]);
    if (!t) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    if (t.owner_id !== req.user.sub && req.user.role !== 'admin') { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Sin permiso' })); }
    await db.run('UPDATE tracks SET visibility = ? WHERE id = ?', [vis, tid]);
    invalidateCatalogCache();
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  const profileTrackPlanMatch = pathname.match(/^\/api\/profile\/tracks\/(\d+)\/planned$/);
  if (profileTrackPlanMatch && method === 'PATCH') {
    if (!requireAuth(req, res)) return;
    const tid = parseInt(profileTrackPlanMatch[1]);
    const body = await parseBody(req);
    const db = sqlDb();
    const t = await db.get('SELECT owner_id FROM tracks WHERE id = ?', [tid]);
    if (!t) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    if (t.owner_id !== req.user.sub && req.user.role !== 'admin') { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Sin permiso' })); }
    await db.run('UPDATE tracks SET planned = ? WHERE id = ?', [body.planned ? 1 : 0, tid]);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  // Logros (gamificación): se calculan al vuelo a partir de las rutas hechas (no planeadas)
  if (pathname === '/api/profile/achievements' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, J);
    return res.end(JSON.stringify(await userAchievements(req.user.sub, await gamificationConfig())));
  }

  if (pathname === '/api/profile/stats' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const db = sqlDb();
    const totals = await db.get(
      `SELECT CAST(COUNT(*) AS INTEGER) AS total_tracks,
              ROUND(CAST(SUM(distance) AS NUMERIC), 1) AS total_km,
              CAST(SUM(elevation_gain) AS INTEGER) AS total_gain,
              CAST(SUM(CASE WHEN circular=1 THEN 1 ELSE 0 END) AS INTEGER) AS circular
       FROM tracks WHERE owner_id = ?`, [req.user.sub]);
    const byActivity = await db.all(
      `SELECT activity, CAST(COUNT(*) AS INTEGER) AS count,
              ROUND(CAST(SUM(distance) AS NUMERIC), 1) AS km,
              CAST(SUM(elevation_gain) AS INTEGER) AS gain
       FROM tracks WHERE owner_id = ? AND activity IS NOT NULL
       GROUP BY activity ORDER BY count DESC`, [req.user.sub]);
    const byYear = await db.all(
      `SELECT CAST(left(date, 4) AS INTEGER) AS year,
              CAST(COUNT(*) AS INTEGER) AS count,
              ROUND(CAST(SUM(distance) AS NUMERIC), 1) AS km
       FROM tracks WHERE owner_id = ? AND date IS NOT NULL AND length(date) >= 4
       GROUP BY year ORDER BY year DESC`, [req.user.sub]);
    res.writeHead(200, J); return res.end(JSON.stringify({ totals, byActivity, byYear }));
  }

  // ── Listas de rutas del usuario ───────────────────────────────────
  // Mis listas (propias)
  if (pathname === '/api/lists' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const db = sqlDb();
    const lists = await db.all(
      `SELECT l.id, l.name, l.description, l.visibility,
              to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS created_at,
              CAST((SELECT COUNT(*) FROM user_list_tracks lt WHERE lt.list_id = l.id) AS INTEGER) AS track_count,
              CAST((SELECT COUNT(*) FROM user_list_shares s WHERE s.list_id = l.id) AS INTEGER) AS share_count
       FROM user_lists l WHERE l.owner_id = ? ORDER BY l.created_at DESC`, [req.user.sub]);
    res.writeHead(200, J); return res.end(JSON.stringify(lists));
  }

  // Listas compartidas conmigo (o públicas de otros)
  if (pathname === '/api/lists/shared' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const db = sqlDb();
    const lists = await db.all(
      `SELECT l.id, l.name, l.description, l.visibility,
              u.username AS owner_username,
              COALESCE(s.can_edit, false) AS can_edit,
              (s.user_id IS NOT NULL) AS shared_with_me,
              CAST((SELECT COUNT(*) FROM user_list_tracks lt WHERE lt.list_id = l.id) AS INTEGER) AS track_count
       FROM user_lists l
       JOIN users u ON u.id = l.owner_id
       LEFT JOIN user_list_shares s ON s.list_id = l.id AND s.user_id = ?
       WHERE l.owner_id <> ? AND (s.user_id IS NOT NULL OR l.visibility = 'public')
       ORDER BY l.created_at DESC`, [req.user.sub, req.user.sub]);
    res.writeHead(200, J); return res.end(JSON.stringify(lists));
  }

  if (pathname === '/api/lists' && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const body = await parseBody(req);
    if (!body.name) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'El nombre es obligatorio' })); }
    const db = sqlDb();
    const row = await db.get(
      'INSERT INTO user_lists (owner_id, name, description) VALUES (?, ?, ?) RETURNING id, name, description, visibility',
      [req.user.sub, body.name, body.description || null]);
    res.writeHead(201, J); return res.end(JSON.stringify({ ...row, track_count: 0, share_count: 0 }));
  }

  const listMatch = pathname.match(/^\/api\/lists\/(\d+)$/);
  if (listMatch && (method === 'PATCH' || method === 'DELETE')) {
    if (!requireAuth(req, res)) return;
    const lid = parseInt(listMatch[1]);
    const db = sqlDb();
    const l = await db.get('SELECT owner_id FROM user_lists WHERE id = ?', [lid]);
    if (!l) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Lista no encontrada' })); }
    if (l.owner_id !== req.user.sub) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Sin permiso' })); }
    if (method === 'DELETE') { await db.run('DELETE FROM user_lists WHERE id = ?', [lid]); res.writeHead(200, J); return res.end(JSON.stringify({ ok: true })); }
    const body = await parseBody(req);
    const updates = []; const vals = [];
    if (body.name !== undefined)        { updates.push('name = ?');        vals.push(body.name); }
    if (body.description !== undefined) { updates.push('description = ?'); vals.push(body.description || null); }
    if (body.visibility === 'public' || body.visibility === 'private') { updates.push('visibility = ?'); vals.push(body.visibility); }
    if (!updates.length) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Nada que actualizar' })); }
    vals.push(lid);
    await db.run(`UPDATE user_lists SET ${updates.join(', ')} WHERE id = ?`, vals);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  // Gestión de comparticiones (solo el dueño)
  const listSharesMatch = pathname.match(/^\/api\/lists\/(\d+)\/shares$/);
  if (listSharesMatch && (method === 'GET' || method === 'POST')) {
    if (!requireAuth(req, res)) return;
    const lid = parseInt(listSharesMatch[1]);
    const db = sqlDb();
    const l = await db.get('SELECT owner_id FROM user_lists WHERE id = ?', [lid]);
    if (!l) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Lista no encontrada' })); }
    if (l.owner_id !== req.user.sub) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Sin permiso' })); }
    if (method === 'GET') {
      const shares = await db.all(
        `SELECT s.user_id, u.username, u.display_name, s.can_edit
         FROM user_list_shares s JOIN users u ON u.id = s.user_id
         WHERE s.list_id = ? ORDER BY u.username`, [lid]);
      res.writeHead(200, J); return res.end(JSON.stringify(shares));
    }
    const body = await parseBody(req);
    const uname = String(body.username || '').trim().toLowerCase();
    const target = body.user_id ? await db.get('SELECT id FROM users WHERE id = ?', [parseInt(body.user_id)])
                                : await db.get('SELECT id FROM users WHERE lower(username) = ?', [uname]);
    if (!target) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Usuario no encontrado' })); }
    if (target.id === req.user.sub) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'La lista ya es tuya' })); }
    const canEdit = body.can_edit === true;
    await db.run(
      `INSERT INTO user_list_shares (list_id, user_id, can_edit) VALUES (?, ?, ?)
       ON CONFLICT (list_id, user_id) DO UPDATE SET can_edit = excluded.can_edit`, [lid, target.id, canEdit ? 1 : 0]);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  const listShareUserMatch = pathname.match(/^\/api\/lists\/(\d+)\/shares\/(\d+)$/);
  if (listShareUserMatch && method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    const lid = parseInt(listShareUserMatch[1]);
    const db = sqlDb();
    const l = await db.get('SELECT owner_id FROM user_lists WHERE id = ?', [lid]);
    if (!l) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Lista no encontrada' })); }
    if (l.owner_id !== req.user.sub) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Sin permiso' })); }
    await db.run('DELETE FROM user_list_shares WHERE list_id = ? AND user_id = ?', [lid, parseInt(listShareUserMatch[2])]);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  const listTracksMatch = pathname.match(/^\/api\/lists\/(\d+)\/tracks$/);
  if (listTracksMatch && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const lid = parseInt(listTracksMatch[1]);
    const acc = await listAccess(lid, req.user.sub, req.user.role === "admin");
    if (!acc.role) { res.writeHead(acc.exists ? 403 : 404, J); return res.end(JSON.stringify({ error: acc.exists ? 'Sin permiso' : 'Lista no encontrada' })); }
    const tracks = await sqlDb().all(
      `SELECT t.id, t.name, t.activity, t.sierra, t.date, t.distance, t.elevation_gain, lt.position
       FROM user_list_tracks lt JOIN tracks t ON t.id = lt.track_id
       WHERE lt.list_id = ? ORDER BY lt.position ASC, t.name COLLATE "C" ASC`, [lid]);
    res.writeHead(200, J); return res.end(JSON.stringify({ role: acc.role, tracks }));
  }

  if (listTracksMatch && method === 'POST') {
    if (!requireAuth(req, res)) return;
    const lid = parseInt(listTracksMatch[1]);
    const acc = await listAccess(lid, req.user.sub, req.user.role === "admin");
    if (acc.role !== 'owner' && acc.role !== 'editor') { res.writeHead(acc.exists ? 403 : 404, J); return res.end(JSON.stringify({ error: acc.exists ? 'No puedes editar esta lista' : 'Lista no encontrada' })); }
    const body = await parseBody(req);
    const trackId = parseInt(body.track_id);
    if (!trackId) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'track_id requerido' })); }
    const db = sqlDb();
    const maxPos = await db.get('SELECT COALESCE(MAX(position),0)+1 AS pos FROM user_list_tracks WHERE list_id = ?', [lid]);
    try {
      await db.run('INSERT INTO user_list_tracks (list_id, track_id, position) VALUES (?, ?, ?)', [lid, trackId, maxPos.pos]);
      res.writeHead(201, J); return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      if (e.message.includes('duplicate') || e.message.includes('unique')) { res.writeHead(409, J); return res.end(JSON.stringify({ error: 'La ruta ya está en la lista' })); }
      throw e;
    }
  }

  const listTrackMatch = pathname.match(/^\/api\/lists\/(\d+)\/tracks\/(\d+)$/);
  if (listTrackMatch && method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    const lid = parseInt(listTrackMatch[1]);
    const acc = await listAccess(lid, req.user.sub, req.user.role === "admin");
    if (acc.role !== 'owner' && acc.role !== 'editor') { res.writeHead(acc.exists ? 403 : 404, J); return res.end(JSON.stringify({ error: acc.exists ? 'No puedes editar esta lista' : 'Lista no encontrada' })); }
    await sqlDb().run('DELETE FROM user_list_tracks WHERE list_id = ? AND track_id = ?', [lid, parseInt(listTrackMatch[2])]);
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true }));
  }

  // Protect all other routes — redirect browsers to /login, return 401 for API
  if (!req.user) {
    const isApi = pathname.startsWith('/api/');
    const isStatic = isPublicFile(pathname.replace(/^\//, ''));
    if (!isStatic) {
      if (isApi) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'No autenticado' })); }
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(pathname)}` }); return res.end();
    }
  }

  // Role gate: Admin and the catalog (editor) are admin-only; other users get the viewer, search,
  // track detail, compare, route drawing and their profile. Everything not allow-listed is refused.
  const isAdmin = req.user?.role === 'admin';
  if (!isAdmin && !userMayAccess(pathname, method)) {
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      res.writeHead(req.user ? 403 : 401, J); return res.end(JSON.stringify({ error: 'Solo para administradores' }));
    }
    res.writeHead(302, { Location: '/' }); return res.end();
  }
  // Single-track access: private tracks only for their owner; editing/deleting only for owner or admin.
  const anyTrackMatch = pathname.match(/^\/api\/tracks\/(\d+)(?:\/(?:gpx|export-gpx))?$/);
  if (anyTrackMatch && !isAdmin) {
    const t = await sqlDb().get('SELECT owner_id, visibility FROM tracks WHERE id = ?', [parseInt(anyTrackMatch[1])]);
    const own = t && t.owner_id === req.user.sub;
    if (!t || (!own && t.visibility !== 'public')) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    if ((method === 'PATCH' || method === 'DELETE') && !own) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Solo el propietario puede modificar esta ruta' })); }
  }

  if (pathname === '/api/db/stats' && method === 'GET')
    return apiStats(res);


  if (pathname === '/api/db/clean' && method === 'POST') {
    const opts = await parseBody(req);
    const args = [];
    if (opts.minDist)  args.push('--min-dist', String(opts.minDist));
    if (opts.maxJump)  args.push('--max-jump', String(opts.maxJump));
    if (opts.rdp)      args.push('--rdp',      String(opts.rdp));
    if (!args.length)  { res.writeHead(400); res.end('No algorithms specified'); return; }
    return apiRunScript(res, path.join(ROOT,'scripts','clean-tracks.js'), args, req.user);
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
    return apiGetTracks(res, isAdmin ? null : req.user.sub, searchParams.get('mine') === '1');

  if (pathname === '/api/tracks/bulk-update' && method === 'POST')
    return apiBulkUpdate(req, res, isAdmin ? null : req.user.sub);

  const trackMoveMatch = pathname.match(/^\/api\/tracks\/(\d+)\/move$/);
  if (trackMoveMatch && method === 'POST') {
    if (!isAdmin && !(await ownsTrack(parseInt(trackMoveMatch[1]), req.user.sub))) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Solo el propietario puede modificar esta ruta' })); }
    return apiMoveTrack(req, res, parseInt(trackMoveMatch[1]));
  }

  const trackMatch = pathname.match(/^\/api\/tracks\/(\d+)$/);
  if (trackMatch && method === 'GET')
    return apiGetTrackById(res, parseInt(trackMatch[1]), searchParams.get('full') === '1');
  if (trackMatch && method === 'PATCH')
    return apiPatchTrack(req, res, parseInt(trackMatch[1]));
  if (trackMatch && method === 'DELETE')
    return apiDeleteTrack(res, parseInt(trackMatch[1]));

  if (pathname === '/api/tracks/bulk-delete' && method === 'POST')
    return apiBulkDelete(req, res, isAdmin ? null : req.user.sub);

  // ── Fotos de un track ─────────────────────────────────────────────
  const trackPhotosMatch = pathname.match(/^\/api\/tracks\/(\d+)\/photos$/);
  if (trackPhotosMatch && method === 'GET') {
    const tid = parseInt(trackPhotosMatch[1]);
    const t = await sqlDb().get('SELECT owner_id, visibility FROM tracks WHERE id = ?', [tid]);
    if (!t) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    if (!isAdmin && t.visibility !== 'public' && t.owner_id !== req.user.sub) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    const cover = (await sqlDb().get('SELECT cover_photo_id FROM tracks WHERE id = ?', [tid])).cover_photo_id;
    const rows = await sqlDb().all('SELECT id, caption, mime, position, thumb_filename FROM track_photos WHERE track_id = ? ORDER BY position, id', [tid]);
    res.writeHead(200, J);
    return res.end(JSON.stringify(rows.map(p => ({ id: p.id, caption: p.caption, mime: p.mime, position: p.position,
      url: `/api/photos/${p.id}`, thumb: `/api/photos/${p.id}?size=thumb`, is_cover: p.id === cover }))));
  }
  if (trackPhotosMatch && method === 'POST') {
    const tid = parseInt(trackPhotosMatch[1]);
    const t = await sqlDb().get('SELECT owner_id, cover_photo_id FROM tracks WHERE id = ?', [tid]);
    if (!t) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    if (!isAdmin && t.owner_id !== req.user.sub) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Solo el propietario puede añadir fotos' })); }
    const body = await parseBody(req);
    const { data: b64, mime: mimeType } = body;
    if (!b64 || !mimeType || !/^image\//.test(mimeType)) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Falta la imagen' })); }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 8 * 1024 * 1024) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'La foto no puede superar 8 MB' })); }
    // Optional small version made by the browser (JPEG), used by lists such as the viewer's
    const thumb = typeof body.thumb === 'string' && body.thumb ? Buffer.from(body.thumb, 'base64') : null;
    const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
    const base = `t${tid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fname = base + ext, tname = thumb && thumb.length <= 1024 * 1024 ? base + '-thumb.jpg' : null;
    try {
      fs.mkdirSync(PHOTOS_DIR, { recursive: true });
      fs.writeFileSync(path.join(PHOTOS_DIR, fname), buf);
      if (tname) fs.writeFileSync(path.join(PHOTOS_DIR, tname), thumb);
    } catch (e) {
      appendLog('error', 'photos', 'No se pudo guardar la foto', { error: e.message });
      res.writeHead(500, J); return res.end(JSON.stringify({ error: 'No se pudo guardar la foto: ' + e.message }));
    }
    const pos = (await sqlDb().get('SELECT COALESCE(MAX(position),0)+1 AS p FROM track_photos WHERE track_id = ?', [tid])).p;
    const row = await sqlDb().get(
      'INSERT INTO track_photos (track_id, owner_id, filename, thumb_filename, mime, size, caption, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [tid, t.owner_id, fname, tname, mimeType, buf.length, (body.caption || '').trim() || null, pos]);
    // The first photo of a route becomes its cover
    const isCover = !t.cover_photo_id || body.cover === true;
    if (isCover) { await sqlDb().run('UPDATE tracks SET cover_photo_id = ? WHERE id = ?', [row.id, tid]); invalidateCatalogCache(); }
    res.writeHead(201, J);
    return res.end(JSON.stringify({ ok: true, id: row.id, url: `/api/photos/${row.id}`, thumb: `/api/photos/${row.id}?size=thumb`, is_cover: isCover }));
  }

  // Duration of a route: declared by the user or detected (same rules as achievements)
  const daysMatch = pathname.match(/^\/api\/tracks\/(\d+)\/days$/);
  if (daysMatch && method === 'GET') {
    const t = await sqlDb().get(
      `SELECT id, name, activity, distance, elevation_gain, moving_time, time_segments, days_declared, owner_id, visibility
       FROM tracks WHERE id = ?`, [parseInt(daysMatch[1])]);
    if (!t || (!isAdmin && t.visibility !== 'public' && t.owner_id !== req.user.sub)) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    const cfg = await gamificationConfig();
    const detected = multiDayInfo({ ...t, days_declared: null }, cfg);
    res.writeHead(200, J);
    return res.end(JSON.stringify({ declared: t.days_declared, detected: { multiDay: detected.multiDay, days: detected.estDays, reason: detected.reason } }));
  }

  // Choose the cover photo of a route (owner or admin)
  const coverMatch = pathname.match(/^\/api\/tracks\/(\d+)\/cover$/);
  if (coverMatch && method === 'PATCH') {
    const tid = parseInt(coverMatch[1]);
    const t = await sqlDb().get('SELECT owner_id FROM tracks WHERE id = ?', [tid]);
    if (!t) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrado' })); }
    if (!isAdmin && t.owner_id !== req.user.sub) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Solo el propietario puede cambiar la portada' })); }
    const body = await parseBody(req);
    const pid = body.photo_id == null ? null : parseInt(body.photo_id);
    if (pid != null && !(await sqlDb().get('SELECT 1 FROM track_photos WHERE id = ? AND track_id = ?', [pid, tid]))) {
      res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Esa foto no es de esta ruta' }));
    }
    await sqlDb().run('UPDATE tracks SET cover_photo_id = ? WHERE id = ?', [pid, tid]);
    invalidateCatalogCache();
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, cover_photo_id: pid }));
  }

  const photoMatch = pathname.match(/^\/api\/photos\/(\d+)$/);
  if (photoMatch && method === 'GET') {
    const p = await sqlDb().get('SELECT tp.filename, tp.thumb_filename, tp.mime, t.owner_id, t.visibility FROM track_photos tp JOIN tracks t ON t.id = tp.track_id WHERE tp.id = ?', [parseInt(photoMatch[1])]);
    if (!p) { res.writeHead(404); return res.end('Not found'); }
    if (!isAdmin && p.visibility !== 'public' && p.owner_id !== req.user.sub) { res.writeHead(404); return res.end('Not found'); }
    const useThumb = searchParams.get('size') === 'thumb' && p.thumb_filename;
    let buf; try { buf = fs.readFileSync(path.join(PHOTOS_DIR, useThumb ? p.thumb_filename : p.filename)); } catch { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': useThumb ? 'image/jpeg' : (p.mime || 'image/jpeg'), 'Cache-Control': 'private, max-age=86400' });
    return res.end(buf);
  }
  if (photoMatch && method === 'DELETE') {
    const pid = parseInt(photoMatch[1]);
    const p = await sqlDb().get('SELECT tp.track_id, tp.filename, tp.thumb_filename, t.owner_id, t.cover_photo_id FROM track_photos tp JOIN tracks t ON t.id = tp.track_id WHERE tp.id = ?', [pid]);
    if (!p) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'No encontrada' })); }
    if (!isAdmin && p.owner_id !== req.user.sub) { res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Sin permiso' })); }
    await sqlDb().run('DELETE FROM track_photos WHERE id = ?', [pid]);   // cover_photo_id → NULL (FK)
    for (const f of [p.filename, p.thumb_filename]) if (f) { try { fs.unlinkSync(path.join(PHOTOS_DIR, f)); } catch {} }
    let newCover = null;
    if (p.cover_photo_id === pid) {   // the cover went away: the next photo takes its place
      const next = await sqlDb().get('SELECT id FROM track_photos WHERE track_id = ? ORDER BY position, id LIMIT 1', [p.track_id]);
      newCover = next ? next.id : null;
      await sqlDb().run('UPDATE tracks SET cover_photo_id = ? WHERE id = ?', [newCover, p.track_id]);
      invalidateCatalogCache();
    }
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, cover_photo_id: newCover }));
  }


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
    return apiRunScript(res, path.join(ROOT, 'scripts', 'wikiloc-import.js'), [url, '--owner', String(req.user.sub)], req.user);
  }

  if (pathname === '/api/import/komoot' && method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const url  = (body.url || '').trim();
    if (!url) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'Missing url'})); }
    return apiRunScript(res, path.join(ROOT, 'scripts', 'komoot-import.js'), [url, '--owner', String(req.user.sub)], req.user);
  }

  if (pathname === '/api/db/import-temp' && method === 'POST') {
    const body  = await parseBody(req).catch(() => ({}));
    const force = body.force || searchParams.get('force') === '1';
    const files = Array.isArray(body.files) && body.files.length ? body.files : null;
    const src   = typeof body.src === 'string' && body.src.trim() ? body.src.trim() : null;
    const keep  = body.keep === true;
    // Non-admins (route drawing / compare → save) may only import the files they just uploaded.
    if (!isAdmin && (!files || src || force)) {
      res.writeHead(403, J); return res.end(JSON.stringify({ error: 'Solo puedes importar las rutas que acabas de subir' }));
    }
    // An admin may assign the imported tracks to any user; everyone else owns what they import.
    let ownerId = req.user.sub;
    if (isAdmin && body.owner_id != null && body.owner_id !== '') {
      const target = parseInt(body.owner_id);
      if (!(await sqlDb().get('SELECT 1 FROM users WHERE id = ?', [target]))) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Usuario destino no encontrado' })); }
      ownerId = target;
    }
    const args  = ['--owner', String(ownerId)];
    if (force) args.push('--force');
    if (files) args.push('--files', files.join('|'));
    if (src)   args.push('--src', src);
    if (keep)  args.push('--keep');
    if (body.allow_dup === true) args.push('--allow-dup');   // the user chose to keep a second copy of their own route
    return apiRunScript(res, path.join(ROOT,'scripts','import-from-temp.js'), args, req.user);
  }


  if (pathname === '/api/db/enrich' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    const ids   = searchParams.get('ids');
    const args  = force ? ['--all'] : ids ? ['--ids', ids] : [];
    return apiRunScript(res, path.join(ROOT,'scripts','enrich-tracks.js'), args, req.user);
  }

  if (pathname === '/api/db/enrich-road-types' && (method === 'POST' || method === 'GET')) {
    const force = searchParams.get('force') === '1';
    const ids   = searchParams.get('ids');
    const args  = ids ? ['--ids', ids] : force ? ['--force'] : [];
    return apiRunScript(res, path.join(ROOT,'scripts','enrich-road-types.js'), args, req.user);
  }

  if (pathname === '/api/db/osm-download' && (method === 'GET' || method === 'POST')) {
    return apiRunScript(res, path.join(ROOT, 'scripts', 'osm-download.js'), [], req.user);
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
    return apiRunScript(res, path.join(ROOT, 'scripts', 'osm-precache.js'), args, req.user);
  }

  if (pathname === '/api/db/export-folders/sync' && method === 'POST') {
    return apiRunScript(res, path.join(ROOT, 'scripts', 'export-folders.js'), [], req.user);
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

  // Default image of an activity (the viewer shows it when a route has no photos). Admin only.
  const actImgMatch = pathname.match(/^\/api\/config\/activities\/(\d+)\/image$/);
  if (actImgMatch && (method === 'POST' || method === 'DELETE')) {
    if (!requireAdmin(req, res)) return;
    const aid = parseInt(actImgMatch[1]);
    const a = await sqlDb().get('SELECT image FROM config_activities WHERE id = ?', [aid]);
    if (!a) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Actividad no encontrada' })); }
    const dir = path.join(PHOTOS_DIR, 'activities');
    const removeOld = () => {   // only files we uploaded; the stock /assets images stay
      const m = /^\/api\/activity-images\/([\w.-]+)$/.exec(a.image || '');
      if (m) { try { fs.unlinkSync(path.join(dir, m[1])); } catch {} }
    };
    let image = null;
    if (method === 'POST') {
      const body = await parseBody(req);
      if (!body.data) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Falta la imagen' })); }
      const buf = Buffer.from(body.data, 'base64');
      if (buf.length > 3 * 1024 * 1024) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'La imagen no puede superar 3 MB' })); }
      const fname = `act-${aid}-${Date.now()}.jpg`;
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, fname), buf); }
      catch (e) { res.writeHead(500, J); return res.end(JSON.stringify({ error: 'No se pudo guardar la imagen: ' + e.message })); }
      image = `/api/activity-images/${fname}`;
    }
    removeOld();
    await sqlDb().run('UPDATE config_activities SET image = ? WHERE id = ?', [image, aid]);
    invalidateCatalogCache();
    appendLog('info', 'activities', image ? 'Imagen de actividad cambiada' : 'Imagen de actividad quitada', { id: aid, by: req.user.username });
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, image }));
  }
  const actImgFile = pathname.match(/^\/api\/activity-images\/([\w.-]+)$/);
  if (actImgFile && method === 'GET') {
    let buf; try { buf = fs.readFileSync(path.join(PHOTOS_DIR, 'activities', actImgFile[1])); } catch { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    return res.end(buf);
  }

  // Illustrated PNG icon of an activity (shows as the small activity icon). Admin only.
  const actIconMatch = pathname.match(/^\/api\/config\/activities\/(\d+)\/icon-image$/);
  if (actIconMatch && (method === 'POST' || method === 'DELETE')) {
    if (!requireAdmin(req, res)) return;
    const aid = parseInt(actIconMatch[1]);
    const a = await sqlDb().get('SELECT icon_img FROM config_activities WHERE id = ?', [aid]);
    if (!a) { res.writeHead(404, J); return res.end(JSON.stringify({ error: 'Actividad no encontrada' })); }
    const dir = path.join(PHOTOS_DIR, 'act-icons');
    const removeOld = () => {
      const m = /^\/api\/activity-icons\/([\w.-]+)$/.exec(a.icon_img || '');
      if (m) { try { fs.unlinkSync(path.join(dir, m[1])); } catch {} }
    };
    let icon_img = null;
    if (method === 'POST') {
      const body = await parseBody(req);
      if (!body.data) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'Falta la imagen' })); }
      const buf = Buffer.from(body.data, 'base64');
      if (buf.length > 3 * 1024 * 1024) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'La imagen no puede superar 3 MB' })); }
      const fname = `icon-${aid}-${Date.now()}.jpg`;
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, fname), buf); }
      catch (e) { res.writeHead(500, J); return res.end(JSON.stringify({ error: 'No se pudo guardar: ' + e.message })); }
      icon_img = `/api/activity-icons/${fname}`;
    }
    removeOld();
    await sqlDb().run('UPDATE config_activities SET icon_img = ? WHERE id = ?', [icon_img, aid]);
    invalidateCatalogCache();
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, icon_img }));
  }
  const actIconFile = pathname.match(/^\/api\/activity-icons\/([\w.-]+)$/);
  if (actIconFile && method === 'GET') {
    let buf; try { buf = fs.readFileSync(path.join(PHOTOS_DIR, 'act-icons', actIconFile[1])); } catch { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    return res.end(buf);
  }

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
    return apiRunScript(res, path.join(ROOT,'scripts','calc-ibp.js'), args, req.user);
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

  if (pathname === '/multidia' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return serveStatic(res, path.join(ROOT, 'multidia.html'), req);
  }

  if (pathname === '/api/admin/storage' && method === 'GET') return apiStorageStatus(res);
  if (pathname === '/api/jobs' && method === 'GET') return apiJobs(res, searchParams);
  if (pathname === '/api/jobs/prune' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const body = await parseBody(req);
    const days = Math.max(0, parseInt(body.days)); if (!Number.isFinite(days)) { res.writeHead(400, J); return res.end(JSON.stringify({ error: 'días inválido' })); }
    const removed = await jobQueue().prune(days);
    appendLog('info', 'jobs', `Purga de trabajos > ${days} día(s): ${removed} eliminados`, { by: req.user.username });
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, removed }));
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)(?:\/(stream|cancel|retry))?$/);
  if (jobMatch && jobMatch[2] === 'stream' && method === 'GET') return streamJob(res, parseInt(jobMatch[1]));
  if (jobMatch && ['cancel', 'retry'].includes(jobMatch[2]) && method === 'POST') return apiJobAction(res, parseInt(jobMatch[1]), jobMatch[2]);
  if (jobMatch && !jobMatch[2] && method === 'GET') {
    const job = await jobQueue().get(parseInt(jobMatch[1]));
    res.writeHead(job ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(job ? { ...job, label: JOBS[job.type]?.label || job.type } : { error: 'Not found' }));
  }
  // ── Admin: parámetros de gamificación ─────────────────────────────
  if (pathname === '/api/admin/gamification' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const stored = await sqlDb().get("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI') AS at, updated_by FROM app_settings WHERE key = 'gamification'").catch(() => null);
    res.writeHead(200, J);
    return res.end(JSON.stringify({ config: await gamificationConfig(), defaults: GAMI_DEFAULTS, customized: !!stored, updated: stored || null }));
  }
  if (pathname === '/api/admin/gamification' && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    let cfg;
    try { cfg = validateConfig(mergeConfig(await parseBody(req))); }
    catch (e) { res.writeHead(400, J); return res.end(JSON.stringify({ error: e.message })); }
    await sqlDb().run(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('gamification', ?, NOW(), ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = NOW(), updated_by = excluded.updated_by`,
      [JSON.stringify(cfg), req.user.username]);
    appendLog('info', 'gamification', 'Parámetros de gamificación guardados', { by: req.user.username });
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, config: cfg }));
  }
  if (pathname === '/api/admin/gamification' && method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    await sqlDb().run("DELETE FROM app_settings WHERE key = 'gamification'");
    appendLog('info', 'gamification', 'Parámetros de gamificación restablecidos', { by: req.user.username });
    res.writeHead(200, J); return res.end(JSON.stringify({ ok: true, config: mergeConfig(null) }));
  }
  if (pathname === '/api/db/backfill-elapsed' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    return apiRunScript(res, path.join(ROOT, 'scripts', 'backfill-elapsed.js'), searchParams.get('all') === '1' ? ['--all'] : [], req.user);
  }
  // Multi-day routes with the saved config
  if (pathname === '/api/admin/gamification/multiday' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const db = sqlDb();
    const cfg = await gamificationConfig();
    const tracks = await db.all(
      `SELECT t.id, t.name, t.activity, t.distance, t.elevation_gain, t.moving_time, t.time_segments, t.days_declared, u.username AS owner
       FROM tracks t LEFT JOIN users u ON u.id = t.owner_id WHERE NOT t.planned`);
    const multiDay = tracks.map(t => ({ t, i: multiDayInfo(t, cfg) })).filter(x => x.i.multiDay)
      .sort((a, b) => b.i.estHours - a.i.estHours)
      .map(({ t, i }) => ({ id: t.id, name: t.name, owner: t.owner, activity: t.activity,
                            km: Math.round(t.distance * 10) / 10, gain: t.elevation_gain,
                            estHours: i.estHours, movingHours: i.movingHours, elapsedHours: i.elapsedHours, reason: i.reason, estDays: i.estDays }));
    res.writeHead(200, J); return res.end(JSON.stringify({ multiDay, totalTracks: tracks.length }));
  }
  // Preview with an unsaved config: which routes count as multi-day and how each user ends up
  if (pathname === '/api/admin/gamification/preview' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let cfg;
    try { cfg = validateConfig(mergeConfig(await parseBody(req))); }
    catch (e) { res.writeHead(400, J); return res.end(JSON.stringify({ error: e.message })); }
    const db = sqlDb();
    const tracks = await db.all(
      `SELECT t.id, t.name, t.activity, t.distance, t.elevation_gain, t.moving_time, t.time_segments, t.days_declared, u.username AS owner
       FROM tracks t LEFT JOIN users u ON u.id = t.owner_id WHERE NOT t.planned`);
    const multiDay = tracks.map(t => ({ t, i: multiDayInfo(t, cfg) })).filter(x => x.i.multiDay)
      .sort((a, b) => b.i.estHours - a.i.estHours)
      .map(({ t, i }) => ({ id: t.id, name: t.name, owner: t.owner, activity: t.activity,
                            km: Math.round(t.distance * 10) / 10, gain: t.elevation_gain,
                            estHours: i.estHours, movingHours: i.movingHours, elapsedHours: i.elapsedHours, reason: i.reason, estDays: i.estDays }));
    const users = await db.all('SELECT id, username FROM users WHERE active ORDER BY username');
    const perUser = [];
    for (const u of users) {
      const a = await userAchievements(u.id, cfg);
      perUser.push({ username: u.username, level: a.level, xp: a.xp, unlocked: a.unlocked, total: a.total });
    }
    res.writeHead(200, J); return res.end(JSON.stringify({ multiDay, perUser, totalTracks: tracks.length }));
  }

  if (pathname === '/api/admin/version' && method === 'GET') {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: pkg.version, name: pkg.name, db: 'postgres' }));
    return;
  }

  // Read/write LOCAL_SYNC_DIR in the host .env (mounted as /app/.env.host)
  const ENV_HOST = path.join(ROOT, '.env.host');
  function readEnvHost() { try { return fs.readFileSync(ENV_HOST, 'utf8'); } catch { return ''; } }
  function getEnvHostVar(k) { const m = readEnvHost().match(new RegExp(`^${k}\\s*=\\s*(.*)$`, 'm')); return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null; }
  function setEnvHostVar(k, v) {
    let txt = readEnvHost();
    const re = new RegExp(`^${k}\\s*=.*$`, 'm');
    txt = re.test(txt) ? txt.replace(re, `${k}=${v}`) : (txt.trimEnd() + '\n' + `${k}=${v}\n`);
    fs.writeFileSync(ENV_HOST, txt, 'utf8');
  }
  if (pathname === '/api/admin/env-config' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ local_sync_dir: getEnvHostVar('LOCAL_SYNC_DIR'), env_writable: fs.existsSync(ENV_HOST) }));
    return;
  }
  if (pathname === '/api/admin/env-config' && method === 'PATCH') {
    const body = await readBody(req);
    if (!fs.existsSync(ENV_HOST)) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '.env.host no montado' })); }
    if (typeof body.local_sync_dir === 'string' && body.local_sync_dir.trim()) setEnvHostVar('LOCAL_SYNC_DIR', body.local_sync_dir.trim());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
  if (pathname === '/subir' && method === 'GET')
    return serveStatic(res, path.join(ROOT, 'subir.html'), req);

  if (pathname === '/api/export/folders' && method === 'POST') {
    const body = await parseBody(req).catch(() => ({}));
    const dest = typeof body.dest === 'string' ? body.dest.trim() : '';
    if (!dest) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Falta el destino' })); }
    const args = ['--dest', dest];
    if (Array.isArray(body.ids) && body.ids.length) args.push('--ids', body.ids.map(Number).filter(Boolean).join(','));
    return apiRunScript(res, path.join(ROOT, 'scripts', 'export-folders.js'), args, req.user);
  }

  if (pathname === '/api/db/extract-urls' && method === 'POST') {
    const force = searchParams.get('force') === '1';
    return apiRunScript(res, path.join(ROOT,'scripts','extract-urls.js'), force ? ['--force'] : [], req.user);
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
