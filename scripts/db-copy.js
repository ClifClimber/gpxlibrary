'use strict';
// Copies all data between the two engines and then checks both return the same.
//   node scripts/db-copy.js --to postgres [--replace]
//   node scripts/db-copy.js --to sqlite [--sqlite data/otra.db] [--replace]
//   node scripts/db-copy.js --verify        (only compares SQLite and Postgres)
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const TO = arg('--to');
const REPLACE = args.includes('--replace');
const VERIFY_ONLY = args.includes('--verify');
if (!VERIFY_ONLY && !['postgres', 'sqlite'].includes(TO)) {
  console.log('Uso: node scripts/db-copy.js --to postgres|sqlite [--sqlite <fichero>] [--replace] | --verify');
  process.exit(1);
}

// The SQLite target must be fixed BEFORE config/db are loaded: they read SQLITE_PATH once.
const ROOT = path.join(__dirname, '..');
const MAIN_DB = path.resolve(ROOT, 'data', 'tracks.db');
const SQLITE_TARGET = TO === 'sqlite' ? path.resolve(arg('--sqlite') || path.join(ROOT, 'data', 'tracks-from-postgres.db')) : null;
// SQLite copies are written to a temporary file that replaces the target only after verification.
const SQLITE_TMP = SQLITE_TARGET ? SQLITE_TARGET + '.copying' : null;
if (SQLITE_TMP) process.env.SQLITE_PATH = SQLITE_TMP;
const config = require('../config');
const SQLITE_PATH = config.SQLITE_PATH;

const { Pool } = require('pg');
const { openDb, closeDb, withTransaction, DB_PATH } = require('./db');
const { migrate } = require('../repo/pg-migrate');
const { createPostgresRepo, lineParams } = require('../repo/postgres');
const { createSqliteRepo } = require('../repo/sqlite');

function removeSqlite(file) { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + ext); } catch (e) { if (e.code !== 'ENOENT') throw e; } } }

// Swap the verified temporary copy into place (the previous target is removed first).
function promoteSqlite() {
  closeDb();
  removeSqlite(SQLITE_TARGET);
  fs.renameSync(SQLITE_TMP, SQLITE_TARGET);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(SQLITE_TMP + ext); } catch {} }
  console.log(`✓ ${path.relative(config.ROOT, SQLITE_TARGET)} sustituido por la copia comprobada`);
}

const toIso = t => (t ? String(t).replace(' ', 'T') + 'Z' : null);
const CONFIG = { config_activities: ['id', 'name', 'color', 'keywords', 'sort_order', 'active'], config_sierras: ['id', 'name', 'sw_lat', 'sw_lon', 'ne_lat', 'ne_lon', 'active'] };

async function toPostgres(pool) {
  await migrate(pool, console.log);
  const n = +(await pool.query('SELECT count(*) FROM tracks')).rows[0].count;
  if (n && !REPLACE) throw new Error(`Postgres ya tiene ${n} rutas. Usa --replace para vaciarlo y copiar de nuevo.`);
  const db = openDb();
  const cols = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
  const rawSt = db.prepare('SELECT lat, lon, ele FROM raw_points WHERE track_id=? ORDER BY seq');
  const cleanSt = db.prepare('SELECT lat, lon, ele FROM clean_points WHERE track_id=? ORDER BY seq');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE tracks, config_activities, config_sierras RESTART IDENTITY');
    for (const [table, c] of Object.entries(CONFIG)) {
      for (const r of db.prepare(`SELECT ${c.join(',')} FROM ${table}`).all()) {
        await client.query(`INSERT INTO ${table} (${c.join(',')}) VALUES (${c.map((_, i) => `$${i + 1}`).join(',')})`, c.map(k => r[k]));
      }
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST((SELECT max(id) FROM ${table}), 1))`);
    }
    const tracks = db.prepare(`SELECT ${cols.join(',')} FROM tracks ORDER BY id`).all();
    let i = 0;
    for (const t of tracks) {
      const [geom, ele] = lineParams(rawSt.all(t.id));
      const [geomC, eleC] = lineParams(cleanSt.all(t.id));
      const vals = cols.map(k => (k === 'imported_at' || k === 'cleaned_at' ? toIso(t[k]) : t[k]));
      const ph = cols.map((_, j) => `$${j + 1}`);
      const b = cols.length;
      await client.query(
        `INSERT INTO tracks (${cols.join(',')}, geom, ele, geom_clean, ele_clean)
         VALUES (${ph.join(',')}, ST_GeomFromText($${b + 1}, 4326), $${b + 2}, ST_GeomFromText($${b + 3}, 4326), $${b + 4})`,
        [...vals, geom, ele, geomC, eleC]);
      if (++i % 50 === 0) console.log(`  … ${i} de ${tracks.length} rutas`);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('tracks','id'), GREATEST((SELECT max(id) FROM tracks), 1))`);
    await client.query('COMMIT');
    console.log(`✓ Copiadas ${tracks.length} rutas a Postgres`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function toSqlite(pool) {
  if (path.resolve(DB_PATH) !== SQLITE_TMP) throw new Error(`Seguridad: la BD abierta (${DB_PATH}) no es el fichero temporal (${SQLITE_TMP}); no se escribe nada.`);
  if (fs.existsSync(SQLITE_TARGET) && !REPLACE) throw new Error(`${SQLITE_TARGET} ya existe. Usa --replace para sobrescribirlo.`);
  if (SQLITE_TARGET === MAIN_DB && !REPLACE) throw new Error('El destino es la base de datos principal: usa --replace si de verdad quieres sustituirla.');
  removeSqlite(SQLITE_TMP);
  const db = openDb();
  const cols = db.prepare('PRAGMA table_info(tracks)').all().map(c => c.name);
  const pgRepo = createPostgresRepo({ pool });
  const tracks = (await pool.query(`SELECT ${cols.map(c => (c === 'imported_at' || c === 'cleaned_at') ? `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') AS ${c}` : c).join(',')} FROM tracks ORDER BY id`)).rows;
  const configRows = {};
  for (const [table, c] of Object.entries(CONFIG)) configRows[table] = (await pool.query(`SELECT ${c.join(',')} FROM ${table} ORDER BY id`)).rows;
  const points = {};
  for (const t of tracks) {
    points[t.id] = { raw: await pgRepo.getPoints(t.id), clean: await pgRepo.getPoints(t.id, { clean: true }) };
  }
  withTransaction(() => {
    for (const [table, c] of Object.entries(CONFIG)) {
      db.exec(`DELETE FROM ${table}`);
      const st = db.prepare(`INSERT INTO ${table} (${c.join(',')}) VALUES (${c.map(() => '?').join(',')})`);
      for (const r of configRows[table]) st.run(...c.map(k => r[k]));
    }
    const ins = db.prepare(`INSERT INTO tracks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    const raw = db.prepare('INSERT INTO raw_points (track_id,seq,lat,lon,ele) VALUES (?,?,?,?,?)');
    const cln = db.prepare('INSERT INTO clean_points (track_id,seq,lat,lon,ele) VALUES (?,?,?,?,?)');
    for (const t of tracks) {
      ins.run(...cols.map(k => t[k]));
      points[t.id].raw.forEach((p, i) => raw.run(t.id, i, p.lat, p.lon, p.ele));
      points[t.id].clean.forEach((p, i) => cln.run(t.id, i, p.lat, p.lon, p.ele));
    }
  });
  console.log(`✓ Copiadas ${tracks.length} rutas (fichero temporal, pendiente de comprobar)`);
}

// Same queries through both repositories must give identical results.
async function verify(pool) {
  const a = createSqliteRepo(), b = createPostgresRepo({ pool });
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const report = [];
  const check = async (label, fn) => { const [x, y] = [await fn(a), await fn(b)]; report.push([label, same(x, y)]); return [x, y]; };
  const [list] = await check('lista de rutas (catálogo)', r => r.listTracks());
  await check('catálogo del visor', r => r.catalogTracks());
  await check('etiquetas', r => r.tags());
  await check('provincias / CCAA / zonas', r => r.geo());
  await check('actividades', r => r.listConfig('config_activities'));
  await check('sierras', r => r.listConfig('config_sierras'));
  let badTracks = 0, badPts = 0, nPts = 0;
  for (const t of list) {
    if (!same(await a.getTrack(t.id), await b.getTrack(t.id))) badTracks++;
    for (const clean of [false, true]) {
      const [p, q] = [await a.getPoints(t.id, { clean }), await b.getPoints(t.id, { clean })];
      nPts += p.length;
      if (!same(p, q)) badPts++;
    }
  }
  report.push([`detalle de ${list.length} rutas`, badTracks === 0]);
  report.push([`${nPts.toLocaleString('es-ES')} puntos GPS`, badPts === 0]);
  console.log('\nComprobación SQLite ↔ Postgres:');
  report.forEach(([l, ok]) => console.log(`  ${ok ? '✓' : '✗'} ${l}`));
  const ok = report.every(r => r[1]);
  console.log(ok ? '✓ Los dos motores devuelven exactamente lo mismo' : '✗ Hay diferencias');
  return ok;
}

(async () => {
  if (!config.DATABASE_URL) throw new Error('Falta DATABASE_URL en .env');
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    console.log(`SQLite  : ${path.relative(config.ROOT, SQLITE_PATH)}`);
    console.log(`Postgres: ${config.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}\n`);
    if (TO === 'postgres') await toPostgres(pool);
    if (TO === 'sqlite') await toSqlite(pool);
    const ok = await verify(pool);
    if (TO === 'sqlite') {
      if (ok) promoteSqlite();
      else { closeDb(); removeSqlite(SQLITE_TMP); console.log('✗ Copia descartada: el destino no se ha tocado'); }
    }
    process.exitCode = ok ? 0 : 2;
  } finally { await pool.end(); }
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
