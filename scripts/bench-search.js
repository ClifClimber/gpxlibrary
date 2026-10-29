'use strict';
// Measures repo/search.js#runSearch on the bench database (gpxlibrary_bench, see synth-tracks.js) WITHOUT the
// pill-count cache (dataVersion: null), so every call pays for page + totals + counts.
//   node scripts/bench-search.js [--runs 40] [--db gpxlibrary_bench]
const { Pool } = require('pg');
const config = require('../config');
const { openSql } = require('../repo/sql');
const { parseSearchParams, runSearch } = require('../repo/search');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const RUNS = parseInt(opt('runs', '40'));
const DB = opt('db', 'gpxlibrary_bench');
if (!/_bench$/.test(DB)) { console.error('Solo se miden bases *_bench'); process.exit(1); }

const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
function viewBox(z, lat, lon) {
  const w = 1200 * 360 / (256 * 2 ** z), h = 800 * (360 / (256 * 2 ** z)) * Math.cos(lat * Math.PI / 180);
  return [lon - w / 2, lat - h / 2, lon + w / 2, lat + h / 2];
}

(async () => {
  const u = new URL(config.DATABASE_URL); u.pathname = '/' + DB;
  const pool = new Pool({ connectionString: u.toString(), max: 4 });
  const db = openSql({ pool });
  const cur = (await db.get('SELECT current_database() d')).d;
  if (cur !== DB) throw new Error('Base inesperada ' + cur);
  const viewer = { sub: (await db.get("SELECT id FROM users WHERE username LIKE 'synth\\_%' ORDER BY id LIMIT 1")).id, role: 'user' };
  const centers = await db.all('SELECT center_lat AS lat, center_lon AS lon, name FROM tracks TABLESAMPLE SYSTEM (0.5) WHERE center_lat IS NOT NULL LIMIT 400');
  const acts = (await db.all('SELECT DISTINCT activity FROM tracks WHERE activity IS NOT NULL LIMIT 12')).map(r => r.activity);
  const words = [...new Set(centers.flatMap(c => c.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)).filter(w => w.length >= 5))];
  const out = [];
  const cases = [];
  for (const z of [6, 9, 12]) for (const filt of [false, true])
    cases.push({ name: `z${z} ${filt ? 'act+dist' : 'sin filtros'}`, mk: () => {
      const c = pick(centers), sp = new URLSearchParams({ bbox: viewBox(z, c.lat, c.lon).join(','), sort: 'name' });
      if (filt) { sp.set('act', pick(acts)); sp.set('dmin', pick([5, 10, 20])); sp.set('dmax', pick([40, 60, 100])); }
      return sp; } });
  cases.push({ name: 'z9 texto', mk: () => { const c = pick(centers); return new URLSearchParams({ bbox: viewBox(9, c.lat, c.lon).join(','), q: pick(words) }); } });
  cases.push({ name: 'z9 radio 25 km', mk: () => { const c = pick(centers); return new URLSearchParams({ bbox: viewBox(9, c.lat, c.lon).join(','), near: `${c.lat},${c.lon},25` }); } });
  cases.push({ name: 'z6 radio 25 km', mk: () => { const c = pick(centers); return new URLSearchParams({ bbox: viewBox(6, c.lat, c.lon).join(','), near: `${c.lat},${c.lon},25` }); } });
  for (const c of cases) {
    const times = [];
    for (let i = 0; i < RUNS + 2; i++) {
      const p = parseSearchParams(c.mk());
      const t0 = process.hrtime.bigint();
      await runSearch(db, p, viewer, { dataVersion: null });
      const dt = Number(process.hrtime.bigint() - t0) / 1e6;
      if (i >= 2) times.push(dt);
    }
    out.push({ caso: c.name, p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1), max: +Math.max(...times).toFixed(1) });
  }
  console.table(out);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
