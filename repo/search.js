'use strict';
// Server-side search for the visor (phase 3, block 3): one page of routes in the visible box with the
// same filters as visor.js, the totals of the box and the cascading counts of the filter pills.
// Semantics mirror visor.js (applyFilters / baseMatch / updateFilterCounts / SORTERS) so both give the
// same answer; `scripts/search-check.js` compares them against a running server.
//
//   parseSearchParams(URLSearchParams) → params      (pure)
//   buildSearchSql(params, viewer)     → { where, facetWhere, args }   (pure, testable)
//   runSearch(db, params, viewer)      → { items, total, km, gain, page, pages, facets }

const { stripAccents, DERIVE_TOLERANCES: TOL } = require('../domain/derive');

const CYCLING = ['MTB', 'MTB Enduro', 'Mtb', 'Gravel', 'Bikepacking', 'Ciclismo de carretera'];
const RUNNING = ['Trail Running', 'Running'];
const MAX_SIZE = 60;
// Counting every match of a huge box (the map zoomed far out) reads tens of thousands of wide rows:
// above this many the total is reported as "more than" and the km/ascent sums are left out
const COUNT_CAP = 1000;
const FACETS_CACHE_MAX = 500;

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const list = (sp, k) => sp.getAll(k).flatMap(v => String(v).split('|')).map(s => s.trim()).filter(Boolean);

/** Query string → normalized params (unknown or bad values are dropped). */
function parseSearchParams(sp) {
  const bbox = (sp.get('bbox') || '').split(',').map(Number);
  const near = (sp.get('near') || '').split(',').map(Number);
  const p = {
    bbox: bbox.length === 4 && bbox.every(Number.isFinite) ? bbox : null,          // w,s,e,n
    acts: list(sp, 'act'), sierras: list(sp, 'sierra'), tags: list(sp, 'tag'),
    rtype: list(sp, 'rtype').filter(r => r === 'circular' || r === 'lineal'),
    distMin: num(sp.get('dmin')), distMax: num(sp.get('dmax')),
    eleMin: num(sp.get('emin')), eleMax: num(sp.get('emax')),
    gradeMin: num(sp.get('gmin')), gradeMax: num(sp.get('gmax')),
    year: /^\d{4}$/.test(sp.get('year') || '') ? sp.get('year') : null,
    q: stripAccents(String(sp.get('q') || '').trim()).toLowerCase() || null,
    near: near.length === 3 && near.every(Number.isFinite) && near[2] > 0 ? near : null,   // lat,lon,km
    mine: sp.get('mine') === '1',
    users: list(sp, 'user').map(Number).filter(Number.isInteger),
    ids: (sp.get('ids') || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0),
    sort: sp.get('sort') || 'name',
    page: Math.max(0, parseInt(sp.get('page')) || 0),
    size: Math.min(MAX_SIZE, Math.max(1, parseInt(sp.get('size')) || 15)),
    starts: sp.get('starts') === '1',
    // Hover line of each item: s1 (15 m) for close zooms, s2 (150 m) when the map is far out
    line: sp.get('line') === 's2' ? 's2' : 's1',
  };
  const grade = p.gradeMin != null || p.gradeMax != null;
  p.gradeActive = grade && ((p.gradeMin ?? 0) > 0 || (p.gradeMax ?? 5) < 5);
  return p;
}

// IBP of the track's activity group and the 0–5 grade (user's choice, else from the rounded IBP), as SQL
const IBP_SQL = `(CASE WHEN t.activity = ANY($ACT_C) THEN t.ibp_bicycle WHEN t.activity = ANY($ACT_R) THEN t.ibp_running ELSE t.ibp_hiking END)`;
const GRADE_SQL = `COALESCE(t.difficulty, CASE WHEN ibp.v IS NULL THEN -1
  WHEN round(ibp.v::numeric) < 0 THEN -1 WHEN round(ibp.v::numeric) <= 50 THEN 0 WHEN round(ibp.v::numeric) <= 100 THEN 1
  WHEN round(ibp.v::numeric) <= 150 THEN 2 WHEN round(ibp.v::numeric) <= 250 THEN 3 WHEN round(ibp.v::numeric) <= 400 THEN 4 ELSE 5 END)`;

// Each matches an index (migrations 016/018), so a page is read in order without sorting every match
const SORTS = {
  'name':      `t.name COLLATE "es-x-icu" ASC`,
  'date':      `t.date DESC NULLS LAST`,
  'id-desc':   `t.id DESC`,
  'dist-asc':  `t.distance ASC`,
  'dist-desc': `t.distance DESC`,
  'ele-desc':  `t.elevation_gain DESC`,
  'ibp-asc':   `COALESCE(round(ibp.v::numeric), 9999) ASC`,
};
// Ties keep the catalog order (newest date, byte-wise name, id), as the stable JS sort does
const TIEBREAK = `t.date DESC NULLS LAST, t.name COLLATE "C" ASC, t.id ASC`;

/**
 * WHERE clauses. `where` = everything (box included); `base` = the filters the pill counts use
 * (no box, no activity/sierra/tag); `actC`/`sierraC`/`tagC` = each pill filter on its own.
 * viewer: { sub, role } — the visor catalog shows public routes + the viewer's own (admins too).
 */
function buildSearchSql(p, viewer) {
  const args = [];
  const $ = v => { args.push(v); return `$${args.length}`; };
  const me = $(viewer.sub), admin = $(viewer.role === 'admin');
  // The owner (and admins) see the whole route; everyone else the privacy-trimmed one
  const full = `(COALESCE(t.owner_id = ${me}, FALSE) OR ${admin})`;   // routes without owner: NULL would drop them
  const geom = `(CASE WHEN ${full} THEN t.geom ELSE t.geom_view END)`;
  // Plain column tests the planner can estimate (OR/CASE over geometries made it scan every public route).
  // geom_s1 exists for every route with geometry; geom_view is NULL when the privacy zone hides the whole
  // route, which then only its owner (and admins) may see.
  const base = [
    `(t.visibility = 'public' OR t.owner_id = ${me})`,
    `t.sw_lat IS NOT NULL`, `t.geom_s1 IS NOT NULL`,
    `(t.geom_view IS NOT NULL OR t.owner_id = ${me} OR ${admin})`,
  ];
  if (p.ids.length) base.push(`t.id = ANY(${$(p.ids)}::int[])`);
  // JS coerces a missing distance/gain to 0 (null >= 5 is false, null <= 40 is true). Written without
  // COALESCE so the planner can use the column statistics.
  const range = (col, min, max) => {
    if (min != null) base.push(min > 0 ? `t.${col} >= ${$(min)}` : `(t.${col} >= ${$(min)} OR t.${col} IS NULL)`);
    if (max != null) base.push(max >= 0 ? `(t.${col} <= ${$(max)} OR t.${col} IS NULL)` : `t.${col} <= ${$(max)}`);
  };
  range('distance', p.distMin, p.distMax);
  range('elevation_gain', p.eleMin, p.eleMax);
  if (p.year) base.push(`t.date LIKE ${$(p.year + '%')}`);
  if (p.q) base.push(`t.search_text LIKE ${$('%' + p.q.replace(/[\\%_]/g, c => '\\' + c) + '%')}`);
  if (p.near) {
    const [lat, lon, km] = p.near;
    const pt = `ST_SetSRID(ST_MakePoint(${$(lon)}, ${$(lat)}), 4326)`;
    // Box prefilter on an indexed column (degrees, generous), then the exact distance to the line
    const deg = $(km / 111 / Math.max(0.2, Math.cos(lat * Math.PI / 180)) + 0.01);
    // Distance to the 15 m simplified line: thousands of times cheaper than the full one, within 15 m of it
    base.push(`t.geom_s1 && ST_Expand(${pt}, ${deg})`, `ST_DWithin(t.geom_s1::geography, ${pt}::geography, ${$(km * 1000)})`);
  }
  if (p.gradeActive) base.push(`${GRADE_SQL} BETWEEN ${$(p.gradeMin ?? 0)} AND ${$(p.gradeMax ?? 5)}`);
  if (p.rtype.length === 1) base.push(p.rtype[0] === 'circular' ? `COALESCE(t.circular, 0) <> 0` : `COALESCE(t.circular, 0) = 0`);
  if (p.mine) base.push(`t.owner_id = ${me}`);
  if (p.users.length) base.push(`t.owner_id = ANY(${$(p.users)}::int[])`);

  const actC = !p.acts.length ? 'TRUE'
    : p.acts.includes('Sin clasificar') ? `(t.activity = ANY(${$(p.acts)}::text[]) OR t.activity IS NULL)`
    : `t.activity = ANY(${$(p.acts)}::text[])`;
  const sierraC = p.sierras.length ? `t.sierra = ANY(${$(p.sierras)}::text[])` : 'TRUE';
  const tagC = p.tags.length
    ? `EXISTS (SELECT 1 FROM json_array_elements_text(COALESCE(NULLIF(t.tags, ''), '[]')::json) tg WHERE tg = ANY(${$(p.tags)}::text[]))`
    : 'TRUE';
  let boxC = 'TRUE';
  if (p.bbox) {
    const [w, s, e, n] = p.bbox;
    const env = `ST_MakeEnvelope(${$(w)}, ${$(s)}, ${$(e)}, ${$(n)}, 4326)`;
    // Bounding boxes overlap, like the visor's bounds.intersects(). geom_s1 (indexed) stands in for the
    // route: its box is at most the 15 m tolerance smaller (and, for the owner, without the privacy zone)
    boxC = `t.geom_s1 && ${env}`;
  }
  const sql = s => s.replace(/\$ACT_C/g, $(CYCLING)).replace(/\$ACT_R/g, $(RUNNING));
  const baseSql = sql(base.join(' AND '));
  return {
    args, geom, full, boxC,
    base: baseSql, actC, sierraC, tagC,
    where: `${baseSql} AND ${actC} AND ${sierraC} AND ${tagC} AND ${boxC}`,
    ibp: sql(IBP_SQL),
  };
}

// Counts of the pills only depend on the filters and the viewer, not on the box: cache them per data version
const _facetCache = new Map();
function facetKey(p, viewer, version) {
  const { bbox, sort, page, size, starts, ...rest } = p;
  return JSON.stringify([version, viewer.sub, viewer.role === 'admin', rest]);
}

// Each query gets only the parameters it uses, renumbered ($9 unused in a query would have no type)
function bind(sql, args) {
  const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => +m[1]))].sort((a, b) => a - b);
  const to = new Map(used.map((n, i) => [n, i + 1]));
  return [sql.replace(/\$(\d+)/g, (_, n) => '$' + to.get(+n)), used.map(n => args[n - 1])];
}

async function runSearch(db, p, viewer, { dataVersion = null } = {}) {
  const s = buildSearchSql(p, viewer);
  const all = sql => db.all(...bind(sql, s.args));
  const get = sql => db.get(...bind(sql, s.args));
  const order = `${SORTS[p.sort] || SORTS.name}, ${TIEBREAK}`;
  const from = `FROM tracks t CROSS JOIN LATERAL (SELECT ${s.ibp} AS v) ibp`;

  const totalsQ = get(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n, COALESCE(SUM(d), 0) AS km, COALESCE(SUM(g), 0) AS gain
     FROM (SELECT t.distance AS d, t.elevation_gain AS g ${from} WHERE ${s.where} LIMIT ${COUNT_CAP + 1}) x`);
  const itemsQ = all(
    `SELECT t.id, t.name, t.date, t.activity, t.sierra, t.ccaa, t.tags, t.distance, t.elevation_gain, t.elevation_loss,
            t.min_elevation, t.max_elevation, t.ibp_bicycle, t.ibp_hiking, t.ibp_running, t.difficulty, t.moving_time, t.stopped_time,
            t.circular, t.owner_id, t.visibility, t.cover_photo_id, t.road_types, u.username AS owner_username,
            ST_AsGeoJSON(ST_StartPoint(${s.geom}), 5) AS start,
            ST_AsGeoJSON(CASE WHEN ${s.full} THEN ST_Transform(ST_Simplify(ST_Transform(t.geom, 3857),
                                ${TOL[p.line]} / cos(radians(ST_Y(ST_Centroid(t.geom)))), true), 4326)
                              ELSE t.geom_${p.line} END, 5) AS line,
            ST_XMin(${s.geom}) AS w, ST_YMin(${s.geom}) AS s, ST_XMax(${s.geom}) AS e, ST_YMax(${s.geom}) AS n
     ${from} LEFT JOIN users u ON u.id = t.owner_id
     WHERE ${s.where} ORDER BY ${order} LIMIT ${p.size} OFFSET ${p.page * p.size}`);
  const startsQ = p.starts
    ? all(`SELECT t.id, t.activity, ST_Y(ST_StartPoint(${s.geom})) AS lat, ST_X(ST_StartPoint(${s.geom})) AS lon
              ${from} WHERE ${s.where} LIMIT 5000`)
    : null;

  const key = facetKey(p, viewer, dataVersion);
  let facetsQ = dataVersion != null ? _facetCache.get(key) : null;
  if (!facetsQ) {
    const one = (expr, extra) => all(
      `SELECT ${expr} AS k, CAST(COUNT(*) AS INTEGER) AS n ${from} WHERE ${s.base} AND ${extra} GROUP BY 1`);
    facetsQ = Promise.all([
      one(`COALESCE(t.activity, 'Sin clasificar')`, `${s.sierraC} AND ${s.tagC}`),
      one(`t.sierra`, `t.sierra IS NOT NULL AND t.sierra <> '' AND ${s.actC} AND ${s.tagC}`),
      all(`SELECT tg AS k, CAST(COUNT(*) AS INTEGER) AS n ${from}
              CROSS JOIN LATERAL json_array_elements_text(COALESCE(NULLIF(t.tags, ''), '[]')::json) tg
              WHERE ${s.base} AND ${s.actC} AND ${s.sierraC} GROUP BY 1`),
    ]).then(([a, si, tg]) => {
      const obj = rows => Object.fromEntries(rows.map(r => [r.k, r.n]));
      return { activity: obj(a), sierra: obj(si), tags: obj(tg) };
    });
    if (dataVersion != null) {
      _facetCache.set(key, facetsQ);
      facetsQ.catch(() => _facetCache.delete(key));
      if (_facetCache.size > FACETS_CACHE_MAX) _facetCache.delete(_facetCache.keys().next().value);
    }
  }

  const [totals, rows, starts, facets] = await Promise.all([totalsQ, itemsQ, startsQ, facetsQ]);
  const coords = g => { try { return JSON.parse(g).coordinates; } catch { return null; } };
  const r0 = v => (v != null ? Math.round(v) : null);
  const items = rows.map(t => {
    const st = coords(t.start);
    const line = coords(t.line);
    let tags = [];
    try { tags = t.tags ? JSON.parse(t.tags) : []; } catch {}
    return {
      id: t.id, name: t.name, date: t.date, activity: t.activity || null, sierra: t.sierra || null, ccaa: t.ccaa || null, tags,
      distance: t.distance, elevationGain: t.elevation_gain, elevationLoss: t.elevation_loss,
      minElevation: r0(t.min_elevation), maxElevation: r0(t.max_elevation),
      ibp_bicycle: r0(t.ibp_bicycle), ibp_hiking: r0(t.ibp_hiking), ibp_running: r0(t.ibp_running), difficulty: t.difficulty ?? null,
      movingTime: t.moving_time || null, stoppedTime: t.stopped_time || null, circular: !!t.circular,
      hasOsm: !!(t.road_types && t.road_types !== '{}'),
      owner_id: t.owner_id || null, owner_username: t.owner_username || null, visibility: t.visibility || 'public',
      cover: t.cover_photo_id ? `/api/photos/${t.cover_photo_id}?size=thumb` : null,
      start: st ? [st[1], st[0]] : null,
      bounds: [[t.s, t.w], [t.n, t.e]],
      line: line ? line.map(c => [c[1], c[0]]) : [],
    };
  });
  const capped = totals.n > COUNT_CAP;
  return {
    items, total: capped ? COUNT_CAP : totals.n, totalCapped: capped,
    km: capped ? null : Number(totals.km), gain: capped ? null : Number(totals.gain),
    page: p.page, size: p.size, pages: Math.ceil((capped ? COUNT_CAP : totals.n) / p.size),
    facets,
    ...(starts ? { starts: starts.map(r => [r.id, Math.round(r.lat * 1e5) / 1e5, Math.round(r.lon * 1e5) / 1e5, r.activity || null]),
                   startsTruncated: starts.length >= 5000 } : {}),
  };
}

module.exports = { parseSearchParams, buildSearchSql, runSearch, bind, SORTS, COUNT_CAP };
