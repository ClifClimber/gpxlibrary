#!/usr/bin/env node
'use strict';
// End-to-end check of the privacy zone against a running server: user A uploads a route and sets a 500 m
// privacy radius; user B must never get a point within 500 m of the route's real start or end, from any
// endpoint (search, preview, detail, GPX download, export, the public page without a session), and nothing at
// all once A makes the route private. Also checks when the public page may be shown (web_visible, source web).
// Creates two throwaway accounts and always deletes them (and with them the route).
//   node scripts/privacy-check.js [--base http://localhost:8081] [--radius 500]
// Exit code 1 if any check fails.
const { havM } = require('../domain/geo');
const { openSql } = require('../repo/sql');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const BASE = opt('base', 'http://localhost:8081');
const RADIUS = parseInt(opt('radius', '500'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let checks = 0;
const failures = [];
const check = (ok, msg) => { checks++; if (!ok) { failures.push(msg); console.log('  ✗ ' + msg); } };

// ── Tiny HTTP client with a cookie per user ─────────────────────────
class User {
  constructor(name) { this.name = name; this.pass = 'pc-' + Math.random().toString(36).slice(2) + 'A1'; this.cookie = ''; this.id = null; }
  async register() {
    const r = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.name, email: `${this.name}@example.com`, password: this.pass, accept: true }) });
    if (!r.ok) throw new Error(`No se pudo crear ${this.name}: HTTP ${r.status} ${await r.text()}`);
    this.cookie = r.headers.get('set-cookie').split(';')[0];
    this.id = (await r.json()).id;
  }
  req(method, url, { json, body, headers } = {}) {
    return fetch(BASE + url, { method, headers: { cookie: this.cookie, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body });
  }
  async json(method, url, opts) { const r = await this.req(method, url, opts); return { status: r.status, body: await r.json().catch(() => null) }; }
  async remove() {
    if (!this.cookie) return;
    const r = await this.req('DELETE', '/api/profile', { json: { password: this.pass } });
    if (!r.ok) console.log(`  ⚠ no se pudo borrar la cuenta ${this.name}: HTTP ${r.status}`);
  }
}

// ── Geometry helpers ────────────────────────────────────────────────
const minTo = (lat, lon, spots) => Math.min(...spots.map(s => havM(lat, lon, s[0], s[1])));
/** Every [lat, lon] must be ≥ RADIUS m from the real start and end. */
function checkPoints(where, pts, spots) {
  let worst = Infinity, n = 0;
  for (const [lat, lon] of pts) { if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue; n++; worst = Math.min(worst, minTo(lat, lon, spots)); }
  check(worst >= RADIUS, `${where}: un punto a ${Math.round(worst)} m del inicio/final real (mínimo ${RADIUS} m, ${n} puntos)`);
  return n;
}
function gpxPoints(text) {
  const out = [];
  for (const m of text.matchAll(/<(trkpt|wpt|rtept)\b([^>]*)>/g)) {
    const lat = /\blat="([^"]+)"/.exec(m[2]), lon = /\blon="([^"]+)"/.exec(m[2]);
    if (lat && lon) out.push([+lat[1], +lon[1], m[1]]);
  }
  return out;
}
const corners = b => (b ? [[b[0][0], b[0][1]], [b[1][0], b[1][1]], [b[0][0], b[1][1]], [b[1][0], b[0][1]]] : []);
function checkItem(where, it, spots) {
  if (it.start) checkPoints(`${where} start`, [it.start], spots);
  checkPoints(`${where} bounds`, corners(it.bounds), spots);
  checkPoints(`${where} line`, it.line || [], spots);
}

async function main(A, B, state) {
  const db = openSql();
  state.db = db;
  await A.register();
  await B.register();
  console.log(`Cuentas: ${A.name} (#${A.id}) y ${B.name} (#${B.id})`);

  // 1. A uploads a route of her own: the GPX of an existing public route (of someone without a privacy zone),
  //    with waypoints added at the real start and end
  const src = await db.get(`SELECT t.id FROM tracks t LEFT JOIN users u ON u.id = t.owner_id
      WHERE t.visibility = 'public' AND COALESCE(u.privacy_radius, 0) = 0 AND t.distance BETWEEN 5 AND 40 AND t.raw_count > 300
      ORDER BY t.id LIMIT 1`);
  if (!src) throw new Error('No hay ninguna ruta pública adecuada para usar de origen');
  let gpx = await (await A.req('GET', `/api/tracks/${src.id}/gpx`)).text();
  const tp = gpxPoints(gpx).filter(p => p[2] === 'trkpt');
  if (tp.length < 50) throw new Error('El GPX de origen tiene pocos puntos');
  const wpt = (p, n) => `<wpt lat="${p[0]}" lon="${p[1]}"><name>${n}</name></wpt>`;
  const extra = wpt(tp[0], 'Casa') + wpt(tp[tp.length - 1], 'Meta') + wpt(tp[Math.floor(tp.length / 2)], 'Cima');
  gpx = gpx.replace(/<trk\b/, extra + '<trk');
  const fname = `privacy-check-${Date.now().toString(36)}.gpx`;
  const up = await A.json('POST', '/api/import/upload', { body: gpx, headers: { 'x-filename': fname, 'Content-Type': 'application/gpx+xml' } });
  if (up.status !== 200) throw new Error('Subida del GPX: HTTP ' + up.status);
  const imp = await A.req('POST', '/api/db/import-temp', { json: { files: [up.body.filename], allow_dup: true } });
  const sse = await imp.text();
  const m = sse.match(/IMPORTED_IDS:(\d+)/);
  if (!m) throw new Error('La importación no devolvió IMPORTED_IDS:\n' + sse.slice(-600));
  const id = +m[1];
  state.id = id;
  console.log(`Ruta #${id} importada (origen #${src.id}, ${tp.length} puntos)`);

  // 2. radius of 500 m; wait for track-derive (the one after the import first, then the one the radius triggers)
  const derived = async () => (await db.get('SELECT derived_at FROM tracks WHERE id = ?', [id]))?.derived_at;
  for (let i = 0; i < 120 && !(await derived()); i++) await sleep(500);
  const t0 = (await db.get('SELECT now() AS t')).t;
  const pr = await A.json('PATCH', '/api/profile/me', { json: { privacy_radius: RADIUS } });
  if (pr.status !== 200) throw new Error('PATCH /api/profile/me: HTTP ' + pr.status);
  let ok = false;
  for (let i = 0; i < 120 && !ok; i++) { const d = await derived(); ok = d && new Date(d) > new Date(t0); if (!ok) await sleep(500); }
  if (!ok) throw new Error('track-derive no actualizó derived_at en 60 s (¿está en marcha el worker?)');
  console.log(`Radio de privacidad ${RADIUS} m aplicado; geometrías derivadas al día`);

  // 3. the real route, as its owner
  const full = await A.json('GET', `/api/tracks/${id}?full=1`);
  check(full.status === 200 && full.body.points?.length > 50, 'el dueño recibe la ruta completa');
  const pts = full.body.points;
  const spots = [[pts[0][0], pts[0][1]], [pts[pts.length - 1][0], pts[pts.length - 1][1]]];
  const ownerWpts = (full.body.waypoints || []).length;
  check(ownerWpts >= 3, `el dueño ve sus ${ownerWpts} puntos de paso (esperados ≥ 3)`);
  console.log(`Inicio real ${spots[0].map(v => v.toFixed(5))} · final real ${spots[1].map(v => v.toFixed(5))}`);

  // 4. B (another account): nothing within RADIUS m of the real start/end
  const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
  const bbox = [Math.min(...lons) - 0.01, Math.min(...lats) - 0.01, Math.max(...lons) + 0.01, Math.max(...lats) + 0.01].join(',');
  let seen = 0;
  for (const variant of ['line=s1', 'line=s2', 'line=s1&starts=1', 'line=s2&starts=1', `ids=${id}`]) {
    const r = await B.json('GET', `/api/search?bbox=${bbox}&size=60&${variant}`);
    const it = r.body?.items?.find(i => i.id === id);
    check(r.status === 200, `search ${variant}: HTTP ${r.status}`);
    check(!!it, `search ${variant}: la ruta no aparece (público, con zona de privacidad)`);
    if (it) { checkItem(`search ${variant}`, it, spots); seen++; }
    for (const s of r.body?.starts || []) if (s[0] === id) checkPoints(`search ${variant} starts`, [[s[1], s[2]]], spots);
    if (it && r.body?.starts) check(r.body.starts.some(s => s[0] === id), `search ${variant}: falta la ruta en starts`);
  }
  const pv = await B.json('GET', `/api/tracks/${id}/preview`);
  check(pv.status === 200, 'preview: HTTP ' + pv.status);
  if (pv.status === 200) checkItem('preview', pv.body, spots);

  const dt = await B.json('GET', `/api/tracks/${id}`);
  const dtFull = await B.json('GET', `/api/tracks/${id}?full=1`);
  for (const [label, r] of [['detalle', dt], ['detalle full=1', dtFull]]) {
    check(r.status === 200, `${label}: HTTP ${r.status}`);
    if (r.status !== 200) continue;
    checkPoints(`${label} puntos`, r.body.points, spots);
    checkPoints(`${label} waypoints`, (r.body.waypoints || []).map(w => [w.lat, w.lon]), spots);
    checkPoints(`${label} bounds`, corners(r.body.bounds), spots);
    checkPoints(`${label} sw/ne/centro/inicio/fin`, [[r.body.sw_lat, r.body.sw_lon], [r.body.ne_lat, r.body.ne_lon], [r.body.center_lat, r.body.center_lon],
      [r.body.start_lat, r.body.start_lon], [r.body.end_lat, r.body.end_lon]], spots);
    check(r.body.points.length < pts.length, `${label}: la ruta de B tiene menos puntos que la del dueño (${r.body.points.length} < ${pts.length})`);
  }

  const gpxTexts = {};
  for (const [label, url] of [['gpx', `/api/tracks/${id}/gpx`], ['gpx?pts=300', `/api/tracks/${id}/gpx?pts=300`], ['gpx?pts=all', `/api/tracks/${id}/gpx?pts=all`],
                              ['export-gpx (GET)', `/api/tracks/${id}/export-gpx`], ['export-gpx (GET simplified)', `/api/tracks/${id}/export-gpx?mode=simplified&pts=200`]]) {
    const r = await B.req('GET', url);
    const txt = await r.text();
    check(r.status === 200, `${label}: HTTP ${r.status}`);
    if (r.status === 200) { gpxTexts[label] = txt; check(checkPoints(label, gpxPoints(txt).map(p => [p[0], p[1]]), spots) > 0, `${label}: GPX sin puntos`); }
  }
  for (const body of [{ ids: [id] }, { ids: [id], mode: 'simplified', pts: 200 }]) {
    const r = await B.req('POST', '/api/tracks/export-gpx', { json: body });
    const txt = await r.text();
    check(r.status === 200, `POST export-gpx ${JSON.stringify(body)}: HTTP ${r.status}`);
    if (r.status === 200) checkPoints(`POST export-gpx ${body.mode || 'full'}`, gpxPoints(txt).map(p => [p[0], p[1]]), spots);
  }
  // the owner still gets everything
  const own = await (await A.req('GET', `/api/tracks/${id}/gpx`)).text();
  check(gpxPoints(own).some(p => minTo(p[0], p[1], spots) < 1), 'el dueño sí recibe su inicio real en el GPX');

  // 4b. without a session: the public page /ruta/{id}-{slug}
  const anon = (url, opts = {}) => fetch(BASE + url, { redirect: 'manual', ...opts });
  const setTrack = fields => A.json('PATCH', `/api/tracks/${id}`, { json: fields });
  await setTrack({ url: null });   // the GPX may carry a source link; with it the page stays hidden (tested below)
  const r0 = await anon(`/ruta/${id}`);
  check(r0.status === 301 && /^\/ruta\/\d+-/.test(r0.headers.get('location') || ''), `página pública: /ruta/${id} redirige a la URL con nombre (HTTP ${r0.status})`);
  const pubUrl = r0.headers.get('location') || `/ruta/${id}`;
  const pg = await anon(pubUrl);
  const html = await pg.text();
  check(pg.status === 200, `página pública sin sesión: HTTP ${pg.status}`);
  const lineJson = /var line = (\[[\s\S]*?\]);\n/.exec(html);
  check(!!lineJson, 'página pública: incluye la línea del mapa');
  if (lineJson) checkPoints('página pública, línea del mapa', JSON.parse(lineJson[1]), spots);
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  check(!!ld && !/latitude|longitude|"geo"/.test(ld[1]), 'página pública: los datos estructurados no llevan coordenadas');
  check(/<meta property="og:title"/.test(html) && /<link rel="canonical"/.test(html), 'página pública: metadatos Open Graph y canónica');
  check((await (await anon('/sitemap.xml')).text()).includes(`/ruta/${id}-`), 'sitemap: incluye la ruta visible en la web');
  // the owner turns «Mostrar mis rutas fuera de la app» off → hidden without a session
  await A.json('PATCH', '/api/profile/me', { json: { web_visible: false } });
  check((await anon(pubUrl)).status === 404, 'web_visible desactivado: la página pública da 404');
  check(!(await (await anon('/sitemap.xml')).text()).includes(`/ruta/${id}-`), 'web_visible desactivado: fuera del sitemap');
  await A.json('PATCH', '/api/profile/me', { json: { web_visible: true } });
  // a source web (e.g. Wikiloc) hides it until the owner confirms it is theirs
  await setTrack({ url: 'https://www.wikiloc.com/rutas/ejemplo-1' });
  check((await anon(pubUrl)).status === 404, 'ruta con web de origen sin confirmar: 404 sin sesión');
  await setTrack({ source_confirmed: true });
  check((await anon(pubUrl)).status === 200, 'ruta con web de origen confirmada como propia: visible sin sesión');
  // B with a session also gets the page (and the button to open it in the app)
  const pgB = await B.req('GET', pubUrl);
  check(pgB.status === 200 && (await pgB.text()).includes(`/track?id=${id}`), 'página pública con sesión: enlace «Abrir en la app»');

  // 5. private: B gets nothing
  const vis = await A.json('PATCH', `/api/profile/tracks/${id}/visibility`, { json: { visibility: 'private' } });
  check(vis.status === 200, 'visibilidad privada: HTTP ' + vis.status);
  for (const [label, method, url, opts] of [
    ['preview', 'GET', `/api/tracks/${id}/preview`], ['detalle', 'GET', `/api/tracks/${id}`], ['detalle full=1', 'GET', `/api/tracks/${id}?full=1`],
    ['gpx', 'GET', `/api/tracks/${id}/gpx`], ['export-gpx (GET)', 'GET', `/api/tracks/${id}/export-gpx`],
    ['POST export-gpx', 'POST', '/api/tracks/export-gpx', { json: { ids: [id] } }]]) {
    const r = await B.req(method, url, opts);
    check(r.status === 404, `privada, ${label}: HTTP ${r.status} (esperado 404)`);
  }
  for (const q of [`bbox=${bbox}&size=60`, `bbox=${bbox}&size=60&starts=1`, `ids=${id}`, `q=${encodeURIComponent('privacy')}&size=60`]) {
    const r = await B.json('GET', `/api/search?${q}`);
    const leaked = JSON.stringify(r.body || {});
    check(r.status === 200 && !(r.body.items || []).some(i => i.id === id) && !(r.body.starts || []).some(s => s[0] === id),
      `privada, search ${q.split('&')[0]}: la ruta sigue apareciendo`);
    void leaked;
  }
  const mine = await A.json('GET', `/api/search?ids=${id}`);
  check(mine.body?.items?.some(i => i.id === id), 'privada: el dueño sigue viéndola');
  check((await fetch(BASE + `/ruta/${id}`, { redirect: 'manual' })).status === 404, 'privada: la página pública da 404 sin sesión');
  check(!(await (await fetch(BASE + '/sitemap.xml')).text()).includes(`/ruta/${id}-`), 'privada: fuera del sitemap');
}

(async () => {
  const stamp = Date.now().toString(36);
  const A = new User(`privcheck.a.${stamp}`), B = new User(`privcheck.b.${stamp}`);
  const state = {};
  let fatal = null;
  try { await main(A, B, state); } catch (e) { fatal = e; }
  // Always: delete both accounts (and with them the route)
  await A.remove(); await B.remove();
  if (state.db) {
    if (state.id) {
      const left = await state.db.get('SELECT 1 AS x FROM tracks WHERE id = ?', [state.id]);
      if (left) { failures.push(`la ruta #${state.id} sigue en la base tras borrar la cuenta`); console.log(`  ✗ la ruta #${state.id} sigue en la base tras borrar la cuenta`); }
    }
    const users = await state.db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE username LIKE ?', [`privcheck.%.${stamp}`]);
    if (users.n) failures.push('quedan cuentas de prueba');
    await state.db.close();
  }
  if (fatal) { console.error('✗ ' + (fatal.stack || fatal.message)); process.exit(1); }
  console.log(failures.length ? `\n✗ ${failures.length} fallo(s) de ${checks} comprobaciones` : `\n✓ ${checks} comprobaciones correctas`);
  process.exit(failures.length ? 1 : 0);
})();
