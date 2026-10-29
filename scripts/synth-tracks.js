'use strict';
// Genera rutas sintéticas en una base APARTE (gpxlibrary_bench) para medir la escala de la fase 3.
//   node scripts/synth-tracks.js --count 10000 [--reset]
// --count es el TOTAL deseado de rutas sintéticas: si ya hay menos, añade las que faltan.
// Lee las rutas reales de `gpxlibrary` SOLO en lectura; no toca S3 ni la base real.
// Cada ruta sintética es una copia de una real trasladada a un punto aleatorio de la península.
const { Pool } = require('pg');
const config = require('../config');
const { migrate } = require('../repo/pg-migrate');

const BENCH_DB = 'gpxlibrary_bench';
const BATCH = 2000;
const ROUTES_PER_USER = 50;
const LAT = [36.0, 43.5], LON = [-9.3, 3.3];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function urlFor(db) {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL no configurada (.env)');
  const u = new URL(config.DATABASE_URL);
  u.pathname = '/' + db;
  return u.toString();
}
const fmt = n => n.toLocaleString('es-ES');

async function ensureBenchDb() {
  const admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
  try {
    const ex = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [BENCH_DB]);
    if (!ex.rowCount) { await admin.query(`CREATE DATABASE ${BENCH_DB}`); console.log(`Base ${BENCH_DB} creada`); }
  } finally { await admin.end(); }
}

// Copia las rutas reales (lectura) a la tabla synth_src de la base bench.
async function loadSources(bench) {
  const real = new Pool({ connectionString: urlFor('gpxlibrary'), max: 1 });
  try {
    await real.query('SET default_transaction_read_only = on');
    const { rows } = await real.query(`
      SELECT name, zone, activity, province, ccaa, sierra, tags, color, distance, elevation_gain, elevation_loss,
             min_elevation, max_elevation, sw_lat, sw_lon, ne_lat, ne_lon, center_lat, center_lon,
             raw_count, ibp_bicycle, ibp_hiking, ibp_running, circular, moving_time, stopped_time,
             road_types, notes, difficulty, search_text, encode(ST_AsEWKB(geom), 'hex') AS geom_hex, ele,
             encode(ST_AsEWKB(geom_s1), 'hex') AS s1_hex, encode(ST_AsEWKB(geom_s2), 'hex') AS s2_hex
      FROM tracks
      WHERE geom IS NOT NULL AND geom_s1 IS NOT NULL AND sw_lat IS NOT NULL AND center_lat IS NOT NULL`);
    await bench.query('DROP TABLE IF EXISTS synth_src');
    await bench.query(`CREATE TABLE synth_src (sid serial PRIMARY KEY, name text, zone text, activity text, province text, ccaa text,
      sierra text, tags text, color text, distance double precision, elevation_gain integer, elevation_loss integer,
      min_elevation integer, max_elevation integer, sw_lat double precision, sw_lon double precision, ne_lat double precision,
      ne_lon double precision, center_lat double precision, center_lon double precision, raw_count integer,
      ibp_bicycle double precision, ibp_hiking double precision, ibp_running double precision, circular integer,
      moving_time integer, stopped_time integer, road_types text, notes text, difficulty integer, search_text text,
      geom geometry(LineString, 4326), ele double precision[], geom_s1 geometry(LineString, 4326), geom_s2 geometry(LineString, 4326))`);
    for (const r of rows) {
      await bench.query(`INSERT INTO synth_src (name, zone, activity, province, ccaa, sierra, tags, color, distance, elevation_gain,
        elevation_loss, min_elevation, max_elevation, sw_lat, sw_lon, ne_lat, ne_lon, center_lat, center_lon, raw_count,
        ibp_bicycle, ibp_hiking, ibp_running, circular, moving_time, stopped_time, road_types, notes, difficulty, search_text, geom, ele,
        geom_s1, geom_s2)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        ST_GeomFromEWKB(decode($31,'hex')),$32,ST_GeomFromEWKB(decode($33,'hex')),ST_GeomFromEWKB(decode($34,'hex')))`,
        [r.name, r.zone, r.activity, r.province, r.ccaa, r.sierra, r.tags, r.color, r.distance, r.elevation_gain, r.elevation_loss,
         r.min_elevation, r.max_elevation, r.sw_lat, r.sw_lon, r.ne_lat, r.ne_lon, r.center_lat, r.center_lon, r.raw_count,
         r.ibp_bicycle, r.ibp_hiking, r.ibp_running, r.circular, r.moving_time, r.stopped_time, r.road_types, r.notes, r.difficulty,
         r.search_text, r.geom_hex, r.ele, r.s1_hex, r.s2_hex]);
    }
    return rows.length;
  } finally { await real.end(); }
}

// Un lote: n rutas nuevas con numeración base+1..base+n, repartidas entre los usuarios `userIds`.
const INSERT_SQL = `
WITH p AS MATERIALIZED (
  SELECT i,
         1 + floor(random() * (SELECT count(*) FROM synth_src))::int AS sid,
         $4::double precision + random() * ($5::double precision - $4::double precision) AS tlat,
         $6::double precision + random() * ($7::double precision - $6::double precision) AS tlon,
         random() AS r_vis, random() AS r_own, random() AS r_date
  FROM generate_series(1, $1::int) i
), q AS MATERIALIZED (
  SELECT p.*, s.*, (p.tlat - s.center_lat) AS dlat, (p.tlon - s.center_lon) AS dlon, gen_random_uuid()::text AS nuid
  FROM p JOIN synth_src s ON s.sid = p.sid
)
INSERT INTO tracks (name, file, zone, date, distance, elevation_gain, elevation_loss, min_elevation, max_elevation,
  sw_lat, sw_lon, ne_lat, ne_lon, center_lat, center_lon, raw_count, cleaned, color, activity, province, ccaa, sierra,
  road_types, moving_time, stopped_time, tags, ibp_bicycle, ibp_hiking, ibp_running, circular, notes, difficulty,
  search_text, uid, sha256, geom, ele, owner_id, visibility, geom_view, geom_s1, geom_s2, start_point, derived_at)
SELECT q.name || ' · v' || ($2::int + q.i), 'synthetic/' || q.nuid || '.gpx', q.zone,
  to_char(date '2008-01-01' + floor(q.r_date * 6800)::int, 'YYYY-MM-DD'),
  q.distance, q.elevation_gain, q.elevation_loss, q.min_elevation, q.max_elevation,
  q.sw_lat + q.dlat, q.sw_lon + q.dlon, q.ne_lat + q.dlat, q.ne_lon + q.dlon, q.tlat, q.tlon,
  q.raw_count, 0, q.color, q.activity, q.province, q.ccaa, q.sierra,
  q.road_types, q.moving_time, q.stopped_time, q.tags, q.ibp_bicycle, q.ibp_hiking, q.ibp_running, q.circular, q.notes, q.difficulty,
  q.search_text,
  q.nuid, encode(sha256(q.nuid::bytea), 'hex'),
  ST_Translate(q.geom, q.dlon, q.dlat), q.ele,
  ($3::int[])[1 + floor(random() * array_length($3::int[], 1))::int], CASE WHEN q.r_vis < 0.9 THEN 'public' ELSE 'private' END,
  -- Derived columns copied from the real route (016). geom_view = the 15 m line, to keep the bench DB small
  -- (privacy zones are not applied to synthetic routes)
  ST_Translate(q.geom_s1, q.dlon, q.dlat), ST_Translate(q.geom_s1, q.dlon, q.dlat), ST_Translate(q.geom_s2, q.dlon, q.dlat),
  ST_StartPoint(ST_Translate(q.geom_s1, q.dlon, q.dlat)), now()
FROM q`;

async function main() {
  const count = Number(arg('count', 0));
  if (!count || count < 0) { console.error('Uso: node scripts/synth-tracks.js --count N [--reset]'); process.exit(1); }
  await ensureBenchDb();
  const bench = new Pool({ connectionString: urlFor(BENCH_DB), max: 2 });
  try {
    const dbname = (await bench.query('SELECT current_database() d')).rows[0].d;
    if (dbname !== BENCH_DB) throw new Error('Base inesperada: ' + dbname);
    const applied = await migrate(bench);
    if (applied.length) console.log(`Migraciones aplicadas: ${applied.length}`);
    if (arg('reset', false)) {
      await bench.query('TRUNCATE tracks, users RESTART IDENTITY CASCADE');
      console.log('Base bench vaciada (--reset)');
    }
    const nSrc = await loadSources(bench);
    console.log(`${nSrc} rutas reales leídas como plantillas (solo lectura)`);

    let have = Number((await bench.query('SELECT count(*) c FROM tracks')).rows[0].c);
    const need = count - have;
    if (need <= 0) { console.log(`Ya hay ${fmt(have)} rutas (>= ${fmt(count)}).`); }

    // Usuarios sintéticos: ceil(count / 50)
    const wantUsers = Math.ceil(count / ROUTES_PER_USER);
    const haveUsers = Number((await bench.query("SELECT count(*) c FROM users WHERE username LIKE 'synth\\_%'")).rows[0].c);
    if (wantUsers > haveUsers) {
      await bench.query(`INSERT INTO users (username, email, password_hash, role, active, display_name, privacy_radius)
        SELECT 'synth_' || n, 'synth' || n || '@bench.invalid', '!', 'user', true, 'Synth ' || n,
               CASE WHEN n % 5 = 1 THEN (ARRAY[200, 500, 1000, 2000])[1 + floor(random() * 4)::int] ELSE 0 END
        FROM generate_series($1::int, $2::int) n`, [haveUsers + 1, wantUsers]);
      console.log(`Usuarios sintéticos: ${wantUsers} (privacy_radius > 0 en ${(await bench.query('SELECT count(*) c FROM users WHERE privacy_radius > 0')).rows[0].c})`);
    }
    if (need > 0) {
      const userIds = (await bench.query("SELECT array_agg(id) a FROM users WHERE username LIKE 'synth\\_%'")).rows[0].a;
      const t0 = Date.now();
      let done = 0;
      while (done < need) {
        const n = Math.min(BATCH, need - done);
        await bench.query(INSERT_SQL,
          [n, have + done, userIds, LAT[0], LAT[1], LON[0], LON[1]]);
        done += n;
        const el = (Date.now() - t0) / 1000;
        if (done % (BATCH * 5) === 0 || done === need)
          console.log(`  ${fmt(have + done)} / ${fmt(count)}  (${(done / el).toFixed(0)} rutas/s, ${el.toFixed(0)} s)`);
      }
    }
    console.log('VACUUM ANALYZE…');
    await bench.query('DROP TABLE IF EXISTS synth_src');
    await bench.query('VACUUM ANALYZE tracks');
    await bench.query('VACUUM ANALYZE users');
    const st = (await bench.query(`SELECT count(*) c, count(*) FILTER (WHERE visibility='private') priv,
      pg_size_pretty(pg_total_relation_size('tracks')) sz FROM tracks`)).rows[0];
    console.log(`Listo: ${fmt(Number(st.c))} rutas (${st.priv} privadas), tabla tracks ${st.sz}`);
  } finally { await bench.end(); }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
