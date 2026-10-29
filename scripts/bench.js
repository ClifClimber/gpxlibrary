'use strict';
// Banco de pruebas de escala (fase 3, bloque 1): mide el catálogo actual y las consultas candidatas.
//   node scripts/bench.js [--db bench|real] [--runs 30] [--tile-budget 15] [--no-precomputed]
// --db bench → base gpxlibrary_bench (datos de scripts/synth-tracks.js). --db real → la base real, SOLO lectura.
// Informe: data/bench/bench-<fecha>-<n>rutas.json  (+ resumen por consola).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../config');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const WHICH = arg('db', 'bench');
const RUNS = Number(arg('runs', 30));
const TILE_BUDGET_MS = Number(arg('tile-budget', 15)) * 1000;   // tope de tiempo por caso de tesela
const ZOOMS_LIST = [6, 9, 12, 14];
const ZOOMS_TILE = [5, 8, 11, 14];
const TOLS_M = [5, 15, 50, 150, 400];
const M_DEG = 111320;                                           // metros por grado de latitud

// Índices creados SOLO en la base bench si una consulta candidata los necesita (se anotan en el informe).
const BENCH_INDEXES = [];

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const r1 = x => (x == null ? null : Math.round(x * 10) / 10);
const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const ms = () => Number(process.hrtime.bigint()) / 1e6;
const stat = (times, extra = {}) => ({ n: times.length, p50: r1(pct(times, 50)), p95: r1(pct(times, 95)), max: r1(Math.max(...times)), ...extra });

function dbUrl() {
  const u = new URL(config.DATABASE_URL);
  u.pathname = '/' + (WHICH === 'real' ? 'gpxlibrary' : 'gpxlibrary_bench');
  return u.toString();
}

let client;
const Q = (sql, p) => client.query(sql, p);

// Ejecuta fn(i) hasta `runs` veces o agotar el presupuesto; descarta una pasada de calentamiento si es rápida.
async function timeCase(fn, { runs = RUNS, budget = Infinity } = {}) {
  const times = [], extras = [];
  const t00 = ms();
  let warmed = false;
  for (let i = 0; i < runs + 1; i++) {
    const t0 = ms();
    let ex;
    try { ex = await fn(i); }
    catch (e) { return { error: e.message, ...(times.length ? stat(times) : {}) }; }
    const dt = ms() - t0;
    if (!warmed && dt < 3000) { warmed = true; continue; }   // calentamiento (no cuenta)
    warmed = true;
    times.push(dt); extras.push(ex);
    if (ms() - t00 > budget) break;
  }
  return { times, extras };
}

// ── Geometría del visor ───────────────────────────────────────────
const mpp = (z, lat) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z;   // metros por píxel (teselas de 256 px)
function viewBox(z, lat, lon) {
  const wDeg = 1200 * 360 / (256 * 2 ** z), hDeg = 800 * (360 / (256 * 2 ** z)) * Math.cos(lat * Math.PI / 180);
  return [lon - wDeg / 2, lat - hDeg / 2, lon + wDeg / 2, lat + hDeg / 2];
}
function tileOf(z, lat, lon) {
  const n = 2 ** z, l = lat * Math.PI / 180;
  return [Math.min(n - 1, Math.floor((lon + 180) / 360 * n)), Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * n))];
}

// ── b1. Lista paginada por caja visible ───────────────────────────────
// Construye WHERE con parámetros numerados dinámicamente.
function listWhere({ box, uid, act, dist }) {
  const p = [uid, ...box];
  let w = `(t.visibility='public' OR t.owner_id=$1) AND t.geom && ST_MakeEnvelope($2,$3,$4,$5,4326)`;
  if (act != null) { p.push(act); w += ` AND t.activity=$${p.length}`; }
  if (dist) { p.push(dist[0], dist[1]); w += ` AND t.distance BETWEEN $${p.length - 1} AND $${p.length}`; }
  return { w, p };
}
async function benchList(ctx) {
  const out = {};
  for (const z of ZOOMS_LIST) {
    out[`z${z}`] = {};
    const boxes = Array.from({ length: RUNS + 1 }, () => { const c = pick(ctx.centers); return { c, box: viewBox(z, c.lat, c.lon) }; });
    for (const mode of ['sin_filtros', 'actividad+distancia']) {
      const filtered = mode !== 'sin_filtros';
      const filt = i => (filtered ? { act: pick(ctx.activities), dist: [pick(ctx.dist.lo), pick(ctx.dist.hi)] } : {});
      const cases = {
        pagina15: i => { const f = filters[i]; const { w, p } = listWhere({ box: boxes[i % boxes.length].box, uid: ctx.uid, ...f });
          return Q(`SELECT t.id, t.name, t.activity, t.distance, t.elevation_gain, t.date, t.center_lat, t.center_lon FROM tracks t WHERE ${w}
                    ORDER BY t.date DESC NULLS LAST, t.name COLLATE "C", t.id LIMIT 15`, p).then(r => r.rowCount); },
        total_km_desnivel: i => { const f = filters[i]; const { w, p } = listWhere({ box: boxes[i % boxes.length].box, uid: ctx.uid, ...f });
          return Q(`SELECT count(*)::int n, sum(t.distance) km, sum(t.elevation_gain) gain FROM tracks t WHERE ${w}`, p).then(r => r.rows[0].n); },
        facetas_actividad: i => { const f = { ...filters[i], act: undefined }; const { w, p } = listWhere({ box: boxes[i % boxes.length].box, uid: ctx.uid, ...f });
          return Q(`SELECT t.activity, count(*)::int n FROM tracks t WHERE ${w} GROUP BY t.activity ORDER BY n DESC`, p).then(r => r.rowCount); },
        facetas_sierra: i => { const { w, p } = listWhere({ box: boxes[i % boxes.length].box, uid: ctx.uid, ...filters[i] });
          return Q(`SELECT t.sierra, count(*)::int n FROM tracks t WHERE ${w} GROUP BY t.sierra ORDER BY n DESC`, p).then(r => r.rowCount); },
      };
      const filters = Array.from({ length: RUNS + 1 }, filt);
      const res = {};
      for (const [name, fn] of Object.entries(cases)) {
        const r = await timeCase(fn, { budget: 60000 });
        res[name] = r.error ? r : stat(r.times, { filas_medias: r1(r.extras.reduce((a, b) => a + b, 0) / r.extras.length) });
      }
      // Recorrido completo de una vista de lista = pagina + total + 2 facetas (secuencial); p95 de la suma por pasada
      const sums = [];
      for (let i = 0; i < Math.min(RUNS, 15); i++) {
        const t0 = ms(); for (const fn of Object.values(cases)) await fn(i); sums.push(ms() - t0);
      }
      res.vista_completa = stat(sums);
      out[`z${z}`][mode] = res;
    }
  }
  return out;
}

// ── b2. Teselas ST_AsMVT ───────────────────────────────────────────
function tileSql(kind) {
  // kind: {tol: metros} simplifica al vuelo; {col: 'geom_s1'} usa la precalculada
  const g = kind.col ? `t.${kind.col}` : (kind.tol ? `ST_Simplify(t.geom, ${(kind.tol / M_DEG).toFixed(8)})` : 't.geom');
  return `WITH env AS (SELECT ST_TileEnvelope($1,$2,$3) e),
    m AS (SELECT t.id, t.activity, t.distance, t.elevation_gain,
                 ST_AsMVTGeom(ST_Transform(${g}, 3857), env.e, 4096, 64, true) AS g
          FROM tracks t, env
          WHERE t.geom && ST_Transform(env.e, 4326) AND (t.visibility='public' OR t.owner_id=$4))
    SELECT ST_AsMVT(m.*, 'tracks', 4096, 'g') AS mvt, count(*)::int AS feats FROM m WHERE g IS NOT NULL`;
}
async function benchTiles(ctx) {
  const out = {};
  const kinds = [{ name: 'sin_simplificar', tol: 0 }, ...TOLS_M.map(t => ({ name: `simplify_${t}m`, tol: t }))];
  if (ctx.precomputed) kinds.push({ name: 'precalc_s1_15m', col: 'geom_s1' }, { name: 'precalc_s2_150m', col: 'geom_s2' });
  for (const z of ZOOMS_TILE) {
    out[`z${z}`] = {};
    const tiles = Array.from({ length: RUNS + 1 }, () => { const c = pick(ctx.centers); return tileOf(z, c.lat, c.lon); });
    for (const k of kinds) {
      const sql = tileSql(k);
      const sizes = [], feats = [];
      const r = await timeCase(async i => { const [x, y] = tiles[i % tiles.length];
        const res = await Q(sql, [z, x, y, ctx.uid]); const b = res.rows[0].mvt; sizes.push(b ? b.length : 0); feats.push(res.rows[0].feats); return 0; },
        { budget: TILE_BUDGET_MS });
      // sizes/feats incluyen la pasada de calentamiento; se descarta la primera si hubo
      const skip = sizes.length - (r.times ? r.times.length : 0);
      const sz = sizes.slice(skip), ft = feats.slice(skip);
      out[`z${z}`][k.name] = r.error ? r : stat(r.times, {
        tesela_KB_media: r1(sz.reduce((a, b) => a + b, 0) / sz.length / 1024), tesela_KB_p95: r1(pct(sz, 95) / 1024),
        rutas_por_tesela_media: r1(ft.reduce((a, b) => a + b, 0) / ft.length), limitada_por_presupuesto: r.times.length < RUNS,
      });
      process.stdout.write('.');
    }
  }
  console.log('');
  return out;
}

// ── b3. Búsqueda de texto ─────────────────────────────────────────
async function benchSearch(ctx) {
  const toks = ctx.words;
  const typo = w => (w.length > 4 ? w.slice(0, 2) + w.slice(3) : w);   // quita una letra
  const out = {};
  const run = async (name, fn) => { const r = await timeCase(fn, { budget: 30000 }); out[name] = r.error ? r : stat(r.times, { filas_medias: r1(r.extras.reduce((a, b) => a + b, 0) / r.extras.length) }); };
  const T = i => toks[i % toks.length];
  await run('ilike_pagina15', i => Q(`SELECT id, name FROM tracks WHERE name ILIKE '%' || $1 || '%' AND (visibility='public' OR owner_id=$2)
    ORDER BY similarity(name, $1) DESC, id LIMIT 15`, [T(i), ctx.uid]).then(r => r.rowCount));
  await run('ilike_total', i => Q(`SELECT count(*)::int n FROM tracks WHERE name ILIKE '%' || $1 || '%' AND (visibility='public' OR owner_id=$2)`, [T(i), ctx.uid]).then(r => r.rows[0].n));
  await run('word_similarity_pagina15', i => Q(`SELECT id, name FROM tracks WHERE $1 <% name AND (visibility='public' OR owner_id=$2)
    ORDER BY word_similarity($1, name) DESC, id LIMIT 15`, [T(i), ctx.uid]).then(r => r.rowCount));
  await run('word_similarity_con_errata', i => Q(`SELECT id, name FROM tracks WHERE $1 <% name AND (visibility='public' OR owner_id=$2)
    ORDER BY word_similarity($1, name) DESC, id LIMIT 15`, [typo(T(i)), ctx.uid]).then(r => r.rowCount));
  await run('similarity_pct_pagina15', i => Q(`SELECT id, name FROM tracks WHERE name % $1 AND (visibility='public' OR owner_id=$2)
    ORDER BY similarity(name, $1) DESC, id LIMIT 15`, [T(i), ctx.uid]).then(r => r.rowCount));
  return out;
}

// ── c. Umbrales de simplificación ───────────────────────────────────
async function benchSimplify() {
  const sample = `(SELECT geom FROM tracks WHERE geom IS NOT NULL ORDER BY random() LIMIT 300) s`;
  const base = (await Q(`SELECT avg(ST_NPoints(geom))::float a FROM ${sample}`)).rows[0].a;
  const points = { original: Math.round(base) };
  for (const tol of TOLS_M) {
    points[`${tol}m`] = Math.round((await Q(`SELECT avg(ST_NPoints(ST_Simplify(geom, $1)))::float a FROM ${sample}`, [tol / M_DEG])).rows[0].a);
  }
  const zooms = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const lat = 40;
  const pixelError = {};
  for (const tol of TOLS_M) {
    pixelError[`${tol}m`] = Object.fromEntries(zooms.map(z => [`z${z}`, Math.round(tol / mpp(z, lat) * 100) / 100]));
  }
  return { puntos_medios_por_ruta: points, metros_por_pixel_lat40: Object.fromEntries(zooms.map(z => [`z${z}`, r1(mpp(z, lat))])), error_visual_px_lat40_teselas256: pixelError };
}

// ── Preparación (columnas precalculadas solo en bench) ───────────────
async function ensurePrecomputed() {
  await Q('ALTER TABLE tracks ADD COLUMN IF NOT EXISTS geom_s1 geometry(LineString, 4326)');
  await Q('ALTER TABLE tracks ADD COLUMN IF NOT EXISTS geom_s2 geometry(LineString, 4326)');
  const pend = Number((await Q('SELECT count(*) c FROM tracks WHERE geom_s1 IS NULL AND geom IS NOT NULL')).rows[0].c);
  if (pend) {
    console.log(`Calculando geom_s1/geom_s2 para ${pend} rutas (solo base bench)…`);
    await Q(`UPDATE tracks SET geom_s1 = ST_Simplify(geom, ${15 / M_DEG}), geom_s2 = ST_Simplify(geom, ${150 / M_DEG}) WHERE geom_s1 IS NULL AND geom IS NOT NULL`);
    await Q('VACUUM ANALYZE tracks');
  }
}

async function main() {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL no configurada (.env)');
  client = new Client({ connectionString: dbUrl() });
  await client.connect();
  await Q('SET statement_timeout = 120000');
  if (WHICH === 'real') await Q('SET default_transaction_read_only = on');
  const info = (await Q(`SELECT current_database() db, version() v, postgis_version() pg, current_setting('shared_buffers') sb,
    (SELECT count(*) FROM tracks)::int n, (SELECT count(*) FROM users)::int nu,
    pg_size_pretty(pg_total_relation_size('tracks')) tsize`)).rows[0];
  const total = info.n;
  const indexesAdded = [];
  if (WHICH === 'bench') {
    for (const ix of BENCH_INDEXES) { await Q(ix); indexesAdded.push(ix); }
  }
  const precomputed = WHICH === 'bench' && !arg('no-precomputed', false);
  if (precomputed) { await ensurePrecomputed(); indexesAdded.push('(columnas, no índices) tracks.geom_s1 = ST_Simplify(geom, 15 m), tracks.geom_s2 = ST_Simplify(geom, 150 m)'); }
  console.log(`Base ${info.db}: ${total} rutas, ${info.nu} usuarios, tabla tracks ${info.tsize}; ${info.v.split(' ').slice(0, 2).join(' ')}, PostGIS ${info.pg}`);

  // Contexto aleatorio común
  const uid = (await Q('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0]?.id ?? 0;
  const centers = (await Q(`SELECT center_lat lat, center_lon lon FROM tracks WHERE visibility='public' AND center_lat IS NOT NULL ORDER BY random() LIMIT 500`)).rows;
  const activities = (await Q(`SELECT activity FROM tracks WHERE activity IS NOT NULL GROUP BY activity ORDER BY count(*) DESC LIMIT 6`)).rows.map(r => r.activity);
  const q = (await Q(`SELECT percentile_cont(ARRAY[0.1,0.2,0.3,0.7,0.8,0.9]::float8[]) WITHIN GROUP (ORDER BY distance) p FROM tracks WHERE distance IS NOT NULL`)).rows[0].p;
  const dist = { lo: q.slice(0, 3), hi: q.slice(3) };
  const names = (await Q('SELECT name FROM tracks ORDER BY random() LIMIT 400')).rows.map(r => r.name);
  const words = names.map(n => (n.match(/[A-Za-zÁÉÍÓÚáéíóúñÑ]{4,}/g) || []).map(w => w.toLowerCase())).filter(a => a.length).map(a => pick(a));
  const ctx = { uid, centers, activities, dist, words, precomputed };

  const report = { meta: { fecha: new Date().toISOString(), base: info.db, rutas: total, usuarios: info.nu, postgres: info.v.split(' ').slice(0, 2).join(' '), postgis: info.pg,
    shared_buffers: info.sb, tabla_tracks: info.tsize, runs: RUNS, viewerUserId: uid, indices_o_columnas_anadidos_en_bench: indexesAdded,
    notas: ['Cache caliente (una pasada de calentamiento por caso); shared_buffers pequeño: con tablas mayores que la RAM de Docker los p95 de producción dependerán del disco.',
            'Las cajas y teselas se centran en rutas existentes elegidas al azar (uso realista).'] } };
  const step = async (label, fn) => { process.stdout.write(`${label}… `); const t0 = ms(); const r = await fn(); console.log(`${((ms() - t0) / 1000).toFixed(1)} s`); return r; };
  report.lista = await step('Lista paginada', () => benchList(ctx));
  report.busqueda = await step('Búsqueda', () => benchSearch(ctx));
  process.stdout.write('Teselas');
  report.teselas = await benchTiles(ctx);
  report.simplificacion = await step('Simplificación', benchSimplify);

  const dir = path.join(config.ROOT, 'data', 'bench');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bench-${new Date().toISOString().slice(0, 10)}-${total}rutas.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  summary(report);
  console.log(`\nInforme: ${file}`);
}

function summary(r) {
  const line = (...a) => console.log(...a);
  line(`\n=== ${r.meta.base} · ${r.meta.rutas} rutas · runs=${r.meta.runs} ===`);
  line('\nLista (p50/p95 ms):');
  for (const [z, modes] of Object.entries(r.lista)) for (const [m, res] of Object.entries(modes))
    line(`  ${z.padEnd(4)} ${m.padEnd(20)} ` + Object.entries(res).map(([k, v]) => `${k}=${v.error ? 'ERR' : v.p50 + '/' + v.p95}`).join('  '));
  line('\nBúsqueda (p50/p95 ms):');
  for (const [k, v] of Object.entries(r.busqueda)) line(`  ${k.padEnd(28)} ${v.error ? 'ERR ' + v.error : v.p50 + '/' + v.p95 + '  (' + v.filas_medias + ' filas)'}`);
  line('\nTeselas (p50/p95 ms · KB medio · rutas/tesela):');
  for (const [z, ks] of Object.entries(r.teselas)) for (const [k, v] of Object.entries(ks))
    line(`  ${z.padEnd(4)} ${k.padEnd(18)} ${v.error ? 'ERR ' + v.error : `${v.p50}/${v.p95} ms · ${v.tesela_KB_media} KB · ${v.rutas_por_tesela_media} rutas${v.limitada_por_presupuesto ? ` · n=${v.n}` : ''}`}`);
  const s = r.simplificacion;
  line('\nPuntos medios por ruta: ' + Object.entries(s.puntos_medios_por_ruta).map(([k, v]) => `${k}=${v}`).join('  '));
  line('Error visual (px) a lat 40:');
  line('  tol     ' + Object.keys(Object.values(s.error_visual_px_lat40_teselas256)[0]).join('\t'));
  for (const [t, row] of Object.entries(s.error_visual_px_lat40_teselas256)) line(`  ${t.padEnd(7)} ` + Object.values(row).join('\t'));
}

main().then(() => client.end()).catch(async e => { console.error('ERROR:', e.stack || e.message); try { await client.end(); } catch {} process.exit(1); });
