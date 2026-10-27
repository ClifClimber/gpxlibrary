'use strict';
// Backup / restore between PostgreSQL (production) and a SQLite file.
// Self-contained: uses node:sqlite and pg directly; no dependency on the deleted sqlite repo.
//   node scripts/db-copy.js --to sqlite [--sqlite <path>]     → dump Postgres to SQLite backup
//   node scripts/db-copy.js --to postgres [--sqlite <path>] [--replace] → load backup into Postgres
const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg  = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const TO      = arg('--to');
const REPLACE = args.includes('--replace');
const SQLITE_ARG = arg('--sqlite') || process.env.SQLITE_PATH || path.join(ROOT, 'data', 'tracks.db');

if (!['postgres', 'sqlite'].includes(TO)) {
  console.log('Uso: node scripts/db-copy.js --to postgres|sqlite [--sqlite <fichero>] [--replace]');
  process.exit(1);
}

// Read DATABASE_URL from the environment (already loaded by the parent process or .env)
if (!process.env.DATABASE_URL) {
  // Minimal .env loader so the script works standalone
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  }
}
if (!process.env.DATABASE_URL) { console.error('✗ Falta DATABASE_URL en .env'); process.exit(1); }

// Honor DATABASE_HOST (host:port) the same way config.js does, so the dump works inside Docker
// where DATABASE_URL in .env points at localhost but Postgres lives at db:5432.
const DB_URL = require('../config').DATABASE_URL || process.env.DATABASE_URL;

const { Pool } = require('pg');
const { DatabaseSync } = require('node:sqlite');
const { parseWkbLine, lineParams } = require('../repo/postgres');
const { migrate } = require('../repo/pg-migrate');

// Postgres columns to copy (everything except the PostGIS geometry/elevation columns)
const SKIP_PG_COLS = new Set(['geom', 'geom_clean', 'ele', 'ele_clean']);
const CONFIG = {
  config_activities: ['id', 'name', 'color', 'keywords', 'sort_order', 'active'],
  config_sierras:    ['id', 'name', 'sw_lat', 'sw_lon', 'ne_lat', 'ne_lon', 'active'],
};

async function getTrackCols(pool) {
  return (await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tracks' ORDER BY ordinal_position"
  )).rows.map(r => r.column_name).filter(c => !SKIP_PG_COLS.has(c));
}

function removeSqlite(file) {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + ext); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

function openSqliteBackup(file, readOnly = false) {
  const db = new DatabaseSync(file, { open: !readOnly });
  if (!readOnly) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`);
    db.exec(`CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY);`);
    db.exec(`CREATE TABLE IF NOT EXISTS raw_points (track_id INTEGER, seq INTEGER, lat REAL, lon REAL, ele REAL);`);
    db.exec(`CREATE TABLE IF NOT EXISTS clean_points (track_id INTEGER, seq INTEGER, lat REAL, lon REAL, ele REAL);`);
    db.exec(`CREATE TABLE IF NOT EXISTS config_activities (id INTEGER PRIMARY KEY, name TEXT, color TEXT, keywords TEXT, sort_order INTEGER DEFAULT 99, active INTEGER DEFAULT 1);`);
    db.exec(`CREATE TABLE IF NOT EXISTS config_sierras (id INTEGER PRIMARY KEY, name TEXT, sw_lat REAL, sw_lon REAL, ne_lat REAL, ne_lon REAL, active INTEGER DEFAULT 1);`);
  }
  return db;
}

// Ensure the SQLite tracks table has all the columns in `cols`
function ensureColumns(db, cols) {
  const existing = new Set(db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name));
  for (const c of cols) {
    if (!existing.has(c)) db.exec(`ALTER TABLE tracks ADD COLUMN ${c} TEXT`);
  }
}

// ── Postgres → SQLite ─────────────────────────────────────────────────────────
async function toSqlite(pool) {
  const tmpFile = SQLITE_ARG + '.copying';
  if (SQLITE_ARG !== (arg('--sqlite') || path.join(ROOT, 'data', 'tracks-from-postgres.db'))) {
    // safety: never overwrite the main DB directly
  }
  removeSqlite(tmpFile);

  const cols = await getTrackCols(pool);
  const db = openSqliteBackup(tmpFile);
  ensureColumns(db, cols);

  const configRows = {};
  for (const [table, c] of Object.entries(CONFIG))
    configRows[table] = (await pool.query(`SELECT ${c.join(',')} FROM ${table} ORDER BY id`)).rows;

  const tracks = (await pool.query(
    `SELECT ${cols.map(c => ['imported_at','cleaned_at'].includes(c)
      ? `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') AS ${c}` : c).join(',')},
     ST_AsBinary(geom) AS geom_wkb, ele,
     ST_AsBinary(geom_clean) AS geom_wkb_clean, ele_clean
     FROM tracks ORDER BY id`
  )).rows;

  console.log(`Volcando ${tracks.length} rutas a ${path.relative(ROOT, SQLITE_ARG)}…`);

  db.exec('BEGIN');
  for (const [table, c] of Object.entries(CONFIG)) {
    for (const r of configRows[table]) {
      db.prepare(`INSERT OR REPLACE INTO ${table} (${c.join(',')}) VALUES (${c.map(() => '?').join(',')})`).run(...c.map(k => r[k]));
    }
  }
  const ins = db.prepare(`INSERT INTO tracks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const rawIns = db.prepare('INSERT INTO raw_points (track_id,seq,lat,lon,ele) VALUES (?,?,?,?,?)');
  const clnIns = db.prepare('INSERT INTO clean_points (track_id,seq,lat,lon,ele) VALUES (?,?,?,?,?)');

  let done = 0;
  for (const t of tracks) {
    ins.run(...cols.map(k => t[k]));
    if (t.geom_wkb) {
      const pts = parseWkbLine(t.geom_wkb);
      pts.forEach((p, i) => rawIns.run(t.id, i, p.lat, p.lon, t.ele ? (t.ele[i] ?? null) : null));
    }
    if (t.geom_wkb_clean) {
      const pts = parseWkbLine(t.geom_wkb_clean);
      pts.forEach((p, i) => clnIns.run(t.id, i, p.lat, p.lon, t.ele_clean ? (t.ele_clean[i] ?? null) : null));
    }
    if (++done % 100 === 0) console.log(`  … ${done} / ${tracks.length}`);
  }
  db.exec('COMMIT');
  db.close();

  // Swap temp into place
  removeSqlite(SQLITE_ARG);
  fs.renameSync(tmpFile, SQLITE_ARG);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmpFile + ext); } catch {} }
  console.log(`✓ ${tracks.length} rutas volcadas a ${path.relative(ROOT, SQLITE_ARG)}`);
  return tracks.length;
}

// ── SQLite → Postgres ─────────────────────────────────────────────────────────
async function toPostgres(pool) {
  if (!fs.existsSync(SQLITE_ARG)) throw new Error(`No existe el fichero: ${SQLITE_ARG}`);
  const db = new DatabaseSync(SQLITE_ARG, { open: true });

  const n = +(await pool.query('SELECT count(*) FROM tracks')).rows[0].count;
  if (n && !REPLACE) throw new Error(`Postgres ya tiene ${n} rutas. Usa --replace para vaciarlo.`);

  await migrate(pool, console.log);

  const cols = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
  const tracks = db.prepare(`SELECT ${cols.join(',')} FROM tracks ORDER BY id`).all();
  const rawSt  = db.prepare('SELECT lat,lon,ele FROM raw_points   WHERE track_id=? ORDER BY seq');
  const clnSt  = db.prepare('SELECT lat,lon,ele FROM clean_points WHERE track_id=? ORDER BY seq');

  console.log(`Cargando ${tracks.length} rutas en Postgres…`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE tracks, config_activities, config_sierras RESTART IDENTITY CASCADE');
    for (const [table, c] of Object.entries(CONFIG)) {
      const rows = db.prepare(`SELECT ${c.join(',')} FROM ${table}`).all();
      for (const r of rows) {
        await client.query(`INSERT INTO ${table} (${c.join(',')}) VALUES (${c.map((_,i)=>`$${i+1}`).join(',')})`, c.map(k => r[k]));
      }
      if (rows.length) await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), (SELECT max(id) FROM ${table}))`);
    }
    const b = cols.length;
    const ph = [...cols.map((_,i)=>`$${i+1}`), `ST_GeomFromText($${b+1},4326)`, `$${b+2}`, `ST_GeomFromText($${b+3},4326)`, `$${b+4}`];
    const insQ = `INSERT INTO tracks (${cols.join(',')},geom,ele,geom_clean,ele_clean) VALUES (${ph.join(',')})`;
    let done = 0;
    for (const t of tracks) {
      const [geom, ele] = lineParams(rawSt.all(t.id));
      const [geomC, eleC] = lineParams(clnSt.all(t.id));
      const vals = cols.map(k => (['imported_at','cleaned_at'].includes(k) && t[k] ? t[k].replace(' ','T')+'Z' : t[k]));
      await client.query(insQ, [...vals, geom, ele, geomC, eleC]);
      if (++done % 100 === 0) console.log(`  … ${done} / ${tracks.length}`);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('tracks','id'), GREATEST((SELECT max(id) FROM tracks),1))`);
    await client.query('COMMIT');
    console.log(`✓ ${tracks.length} rutas cargadas en Postgres`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); db.close(); }
  return tracks.length;
}

(async () => {
  const pool = new Pool({ connectionString: DB_URL });
  try {
    if (TO === 'sqlite') await toSqlite(pool);
    else                 await toPostgres(pool);
  } finally { await pool.end(); }
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
