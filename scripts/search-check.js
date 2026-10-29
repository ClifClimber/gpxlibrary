#!/usr/bin/env node
'use strict';
// Compares GET /api/search with an independent JavaScript implementation of the visor's filters, counts and
// sort (the logic visor.js had when it filtered the whole catalog in the browser), for random boxes and filters.
// The reference data is read straight from the database (public routes, as the throwaway account sees them).
// Creates a throwaway account, runs the checks against a running server and deletes the account.
//   node scripts/search-check.js [--base http://localhost:8081] [--runs 300] [--seed 1]
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const BASE = opt('base', 'http://localhost:8081');
const RUNS = parseInt(opt('runs', '300'));
let seed = parseInt(opt('seed', '1'));
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = a => a[Math.floor(rnd() * a.length)];
const sample = (a, n) => [...a].sort(() => rnd() - 0.5).slice(0, n);

// ── Reference: the same logic as visor.js ──────────────────────────
const IBP_LEVELS = [[0, 50], [51, 100], [101, 150], [151, 250], [251, 400], [401, Infinity]];
const CYC = ['MTB', 'MTB Enduro', 'Mtb', 'Gravel', 'Bikepacking', 'Ciclismo de carretera'];
const RUN = ['Trail Running', 'Running'];
const ibpFor = t => (CYC.includes(t.activity) ? t.ibp_bicycle : RUN.includes(t.activity) ? t.ibp_running : t.ibp_hiking);
const levelIdx = v => (v == null ? -1 : IBP_LEVELS.findIndex(([a, b]) => v >= a && v <= b));
const gradeIdx = t => (t.difficulty != null ? t.difficulty : levelIdx(ibpFor(t)));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const hav = (la1, lo1, la2, lo2) => {
  const D = Math.PI / 180, dl = (la2 - la1) * D, dn = (lo2 - lo1) * D;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(la1 * D) * Math.cos(la2 * D) * Math.sin(dn / 2) ** 2));
};
const coll = new Intl.Collator('es');
const SORTERS = {
  'name':      (a, b) => coll.compare(a.name, b.name),
  'date':      (a, b) => (b.date || '').localeCompare(a.date || ''),
  'id-desc':   (a, b) => b.id - a.id,
  'dist-desc': (a, b) => b.distance - a.distance,
  'ele-desc':  (a, b) => b.elevationGain - a.elevationGain,
  'ibp-asc':   (a, b) => (ibpFor(a) ?? 9999) - (ibpFor(b) ?? 9999),
};

function reference(cat, f, me) {
  const base = t =>
    t.distance >= (f.dmin ?? 0) && t.distance <= (f.dmax ?? Infinity) &&
    t.elevationGain >= (f.emin ?? 0) && t.elevationGain <= (f.emax ?? Infinity) &&
    (!f.year || (t.date && t.date.startsWith(f.year))) &&
    (!f.q || norm(f.q).split(/\s+/).every(w => t._q.includes(w))) &&
    (!f.near || hav(f.near[0], f.near[1], t.center[0], t.center[1]) <= f.near[2] || t.points.some(p => hav(f.near[0], f.near[1], p[0], p[1]) <= f.near[2])) &&
    (!f.grade || (gradeIdx(t) >= f.grade[0] && gradeIdx(t) <= f.grade[1])) &&
    (!f.rtype || (f.rtype === 'circular' ? t.circular : !t.circular)) &&
    (!f.mine || t.owner_id === me);
  const actOk = t => !f.acts.length || f.acts.includes(t.activity || 'Sin clasificar');
  const sierraOk = t => !f.sierras.length || f.sierras.includes(t.sierra);
  const tagsOk = t => !f.tags.length || (t.tags || []).some(x => f.tags.includes(x));
  const inView = t => { const [[s, w], [n, e]] = t.bounds, [W, S, E, N] = f.bbox; return !(e < W || w > E || n < S || s > N); };
  const vis = cat.filter(t => inView(t) && base(t) && actOk(t) && sierraOk(t) && tagsOk(t));
  const b = cat.filter(base);
  const facets = { activity: {}, sierra: {}, tags: {} };
  for (const t of b) {
    if (sierraOk(t) && tagsOk(t)) { const a = t.activity || 'Sin clasificar'; facets.activity[a] = (facets.activity[a] || 0) + 1; }
    if (actOk(t) && tagsOk(t) && t.sierra) facets.sierra[t.sierra] = (facets.sierra[t.sierra] || 0) + 1;
    if (actOk(t) && sierraOk(t)) (t.tags || []).forEach(x => { facets.tags[x] = (facets.tags[x] || 0) + 1; });
  }
  const sorted = [...vis].sort(SORTERS[f.sort]);
  return {
    total: vis.length, km: vis.reduce((s, t) => s + (t.distance || 0), 0), gain: vis.reduce((s, t) => s + (t.elevationGain || 0), 0),
    page: sorted.slice(f.page * 15, f.page * 15 + 15), facets,
  };
}

// ── Random filters ─────────────────────────────────────────────────
function randomFilter(cat) {
  const acts = [...new Set(cat.map(t => t.activity || 'Sin clasificar'))];
  const sierras = [...new Set(cat.map(t => t.sierra).filter(Boolean))];
  const tags = [...new Set(cat.flatMap(t => t.tags || []))];
  const words = [...new Set(cat.flatMap(t => norm(t.name).split(/[^a-z0-9ñ]+/)).filter(w => w.length >= 4))];
  const c = pick(cat).center, span = pick([0.05, 0.2, 0.8, 3, 10]);
  const f = {
    bbox: [c[1] - span * 1.4, c[0] - span, c[1] + span * 1.4, c[0] + span],
    acts: rnd() < 0.3 ? sample(acts, 1 + Math.floor(rnd() * 2)) : [],
    sierras: rnd() < 0.15 ? sample(sierras, 1) : [],
    tags: rnd() < 0.1 && tags.length ? sample(tags, 1) : [],
    sort: pick(Object.keys(SORTERS)), page: rnd() < 0.2 ? 1 : 0,
  };
  if (rnd() < 0.2) f.dmin = pick([5, 10, 20]);
  if (rnd() < 0.2) f.dmax = pick([15, 30, 60]);
  if (rnd() < 0.15) f.emin = pick([300, 800]);
  if (rnd() < 0.1) f.emax = pick([500, 1500]);
  if (rnd() < 0.1) f.year = String(pick(cat.filter(t => t.date)).date).slice(0, 4);
  if (rnd() < 0.15 && words.length) f.q = pick(words);
  if (rnd() < 0.15) f.grade = pick([[0, 1], [2, 3], [3, 5], [1, 4]]);
  if (rnd() < 0.1) f.rtype = pick(['circular', 'lineal']);
  if (rnd() < 0.08) { const t = pick(cat); f.near = [t.center[0], t.center[1], pick([5, 25])]; }
  return f;
}
function toQuery(f) {
  const sp = new URLSearchParams({ bbox: f.bbox.join(','), sort: f.sort, page: String(f.page) });
  f.acts.forEach(a => sp.append('act', a)); f.sierras.forEach(s => sp.append('sierra', s)); f.tags.forEach(t => sp.append('tag', t));
  for (const k of ['dmin', 'dmax', 'emin', 'emax', 'year', 'q']) if (f[k] != null) sp.set(k, f[k]);
  if (f.grade) { sp.set('gmin', f.grade[0]); sp.set('gmax', f.grade[1]); }
  if (f.rtype) sp.set('rtype', f.rtype);
  if (f.near) sp.set('near', f.near.join(','));
  return sp.toString();
}

// Public routes as another user sees them: the privacy-trimmed 15 m line (geom_s1), its box and its points
async function loadCatalog() {
  const { openSql } = require('../repo/sql');
  const db = openSql();
  const rows = await db.all(`SELECT id, name, sierra, zone, province, activity, tags, distance, elevation_gain, date, circular, owner_id, difficulty,
      ibp_bicycle, ibp_hiking, ibp_running, ST_AsGeoJSON(geom_s1, 5) AS line,
      ST_XMin(geom_s1) AS w, ST_YMin(geom_s1) AS s, ST_XMax(geom_s1) AS e, ST_YMax(geom_s1) AS n
    FROM tracks WHERE visibility = 'public' AND sw_lat IS NOT NULL AND geom_s1 IS NOT NULL AND geom_view IS NOT NULL
    ORDER BY date DESC NULLS LAST, name COLLATE "C", id`);   // the old catalog order: the stable JS sort keeps it for ties
  await db.close();
  const r0 = v => (v != null ? Math.round(v) : null);
  return rows.map(t => {
    let tags = []; try { tags = t.tags ? JSON.parse(t.tags) : []; } catch {}
    const points = JSON.parse(t.line).coordinates.map(c => [c[1], c[0]]);
    return {
      id: t.id, name: t.name, sierra: t.sierra, activity: t.activity, tags, date: t.date, circular: !!t.circular, owner_id: t.owner_id,
      distance: t.distance, elevationGain: t.elevation_gain, difficulty: t.difficulty,
      ibp_bicycle: r0(t.ibp_bicycle), ibp_hiking: r0(t.ibp_hiking), ibp_running: r0(t.ibp_running),
      bounds: [[t.s, t.w], [t.n, t.e]], center: points[Math.floor(points.length / 2)], points,
      _q: norm([t.name, t.sierra, t.zone, t.province, t.activity, ...tags].filter(Boolean).join(' ')),
    };
  });
}

// ── Run ─────────────────────────────────────────────────────────────
(async () => {
  const user = `check.${Date.now().toString(36)}`, pass = 'check-' + Math.random().toString(36).slice(2);
  const reg = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, email: `${user}@example.com`, password: pass, accept: true }) });
  if (!reg.ok) throw new Error('No se pudo crear la cuenta de prueba: ' + (await reg.text()));
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const me = (await reg.json()).id;
  const get = async url => { const r = await fetch(BASE + url, { headers: { cookie } }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
  try {
    const cat = await loadCatalog();
    console.log(`Catálogo: ${cat.length} rutas · ${RUNS} búsquedas aleatorias`);
    const bad = { total: 0, totals: 0, page: 0, facets: 0 }, examples = [], times = [];
    for (let i = 0; i < RUNS; i++) {
      const f = randomFilter(cat), ref = reference(cat, f, me);
      const t0 = Date.now();
      const got = await get('/api/search?' + toQuery(f));
      times.push(Date.now() - t0);
      const errs = [];
      if (got.total !== ref.total) errs.push(`total ${got.total} ≠ ${ref.total}`);
      else if (Math.abs(got.km - ref.km) > 0.01 || got.gain !== ref.gain) errs.push(`km/desnivel ${got.km}/${got.gain} ≠ ${ref.km}/${ref.gain}`);
      if (!errs.length) {
        const a = got.items.map(t => t.id).join(','), b = ref.page.map(t => t.id).join(',');
        if (a !== b) errs.push(`página [${a}] ≠ [${b}]`);
      }
      const fk = JSON.stringify(Object.fromEntries(Object.entries(got.facets).map(([k, v]) => [k, Object.entries(v).sort()])));
      const fr = JSON.stringify(Object.fromEntries(Object.entries(ref.facets).map(([k, v]) => [k, Object.entries(v).sort()])));
      if (fk !== fr) errs.push('recuentos distintos');
      if (errs.length) {
        if (errs.some(e => e.startsWith('total'))) bad.total++; if (errs.some(e => e.startsWith('km'))) bad.totals++;
        if (errs.some(e => e.startsWith('página'))) bad.page++; if (errs.includes('recuentos distintos')) bad.facets++;
        if (examples.length < 8) examples.push({ query: toQuery(f), errs });
      }
    }
    times.sort((a, b) => a - b);
    console.log(`Diferencias → total: ${bad.total} · km/desnivel: ${bad.totals} · orden de la página: ${bad.page} · recuentos: ${bad.facets}`);
    console.log(`Tiempo /api/search: p50 ${times[Math.floor(times.length * 0.5)]} ms · p95 ${times[Math.floor(times.length * 0.95)]} ms`);
    for (const e of examples) console.log('  ·', e.errs.join(' · '), '\n    ', decodeURIComponent(e.query));
    process.exitCode = Object.values(bad).some(Boolean) ? 1 : 0;
  } finally {
    await fetch(`${BASE}/api/profile`, { method: 'DELETE', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) });
  }
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
