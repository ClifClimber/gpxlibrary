'use strict';
// Server-side search for the visor (phase 3, block 3): one page of routes in the visible box with the
// same filters as visor.js, the totals of the box and the cascading counts of the filter pills.
// Semantics mirror visor.js (applyFilters / baseMatch / updateFilterCounts / SORTERS) so both give the
// same answer; `scripts/search-check.js` compares them against a running server.
//
// Filtering, totals and counts read the narrow table `track_search` (migration 020, kept by triggers on
// `tracks`), aliased `t`; only the page of ≤60 routes and their geometries are read from `tracks` (`tr`).
//
//   parseSearchParams(URLSearchParams) → params      (pure)
//   buildSearchSql(params, viewer)     → { where, base, … args }   (pure, testable)
//   runSearch(db, params, viewer)      → { items, total, km, gain, page, pages, facets, fuzzy? }

const { stripAccents, DERIVE_TOLERANCES: TOL } = require('../domain/derive');

// Kept in step with the lists inside track_search_sync() (migration 020); search.test.js checks it
const CYCLING = ['MTB', 'MTB Enduro', 'Mtb', 'Gravel', 'Bikepacking', 'Ciclismo de carretera'];
const RUNNING = ['Trail Running', 'Running'];
const MAX_SIZE = 60;
// Counting every match of a huge box (the map zoomed far out) reads tens of thousands of rows:
// above this many the total is reported as "more than" and the km/ascent sums are left out
const COUNT_CAP = 1000;
const FACETS_CACHE_MAX = 500;
// Typo tolerance (pg_trgm strict_word_similarity: the best run of whole words of the text against the typed word).
// «pealara» → «peñalara» scores 0.55, «gredoz» → «gredos» 0.56, «candelda» → «candeleda» 0.58, while unrelated
// look-alikes stay lower («pealara» vs «tralara» 0.33). Plain word_similarity cannot tell those apart.
const FUZZY_THRESHOLD = 0.45;
const FUZZY_MIN_LEN = 3;   // shorter words are matched exactly

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
    fuzzy: false,   // set by runSearch when the exact text search finds nothing
  };
  const grade = p.gradeMin != null || p.gradeMax != null;
  p.gradeActive = grade && ((p.gradeMin ?? 0) > 0 || (p.gradeMax ?? 5) < 5);
  return p;
}

// Each matches an index of track_search (migration 020), so a page is read in order without sorting every match
const SORTS = {
  'name':      `t.name COLLATE "es-x-icu" ASC`,
  'date':      `t.date DESC NULLS LAST`,
  'id-desc':   `t.id DESC`,
  'dist-asc':  `t.distance ASC`,
  'dist-desc': `t.distance DESC`,
  'ele-desc':  `t.elevation_gain DESC`,
  'ibp-asc':   `t.ibp_sort ASC`,
};
// Ties keep the catalog order (newest date, byte-wise name, id), as the stable JS sort does
const TIEBREAK = `t.date DESC NULLS LAST, t.name COLLATE "C" ASC, t.id ASC`;

const words = p => (p.q ? p.q.split(/\s+/).filter(Boolean) : []);
const likeArg = w => '%' + w.replace(/[\\%_]/g, c => '\\' + c) + '%';

/**
 * WHERE clauses over track_search (alias `t`). `where` = everything (box included); `base` = the filters the
 * pill counts use (no box, no activity/sierra/tag); `actC`/`sierraC`/`tagC` = each pill filter on its own.
 * viewer: { sub, role } — the visor catalog shows public routes + the viewer's own (admins too).
 * opts.nearIds: ids already matching the radius filter (runSearch computes them once instead of three times).
 * `full`/`geom` refer to the `tracks` row (alias `tr`) of the page query.
 */
function buildSearchSql(p, viewer, { nearIds = null } = {}) {
  const args = [];
  const $ = v => { args.push(v); return `$${args.length}`; };
  const me = $(viewer.sub), admin = $(viewer.role === 'admin');
  // The owner (and admins) see the whole route; everyone else the privacy-trimmed one
  const full = `(COALESCE(tr.owner_id = ${me}, FALSE) OR ${admin})`;   // routes without owner: NULL would drop them
  const geom = `(CASE WHEN ${full} THEN tr.geom ELSE tr.geom_view END)`;
  // `hidden`: the privacy zone covers the whole route, so only its owner (and admins) may see it
  const vis = [`(t.visibility = 'public' OR t.owner_id = ${me})`, `(NOT t.hidden OR t.owner_id = ${me} OR ${admin})`];
  const base = [...vis];
  if (p.ids.length) base.push(`t.id = ANY(${$(p.ids)}::int[])`);
  // JS coerces a missing distance/gain to 0 (null >= 5 is false, null <= 40 is true)
  const range = (col, min, max) => {
    if (min != null) base.push(min > 0 ? `t.${col} >= ${$(min)}` : `(t.${col} >= ${$(min)} OR t.${col} IS NULL)`);
    if (max != null) base.push(max >= 0 ? `(t.${col} <= ${$(max)} OR t.${col} IS NULL)` : `t.${col} <= ${$(max)}`);
  };
  range('distance', p.distMin, p.distMax);
  range('elevation_gain', p.eleMin, p.eleMax);
  if (p.year) base.push(`t.date LIKE ${$(p.year + '%')}`);
  // Every word must appear (name, sierra, zone, province, activity or tags), in any order. Fuzzy mode (no
  // exact result): each word of ≥3 letters only has to be similar to a word of the text (pg_trgm `<<%`)
  let rank = null;
  const ws = words(p);
  for (const w of ws) {
    if (p.fuzzy && w.length >= FUZZY_MIN_LEN) base.push(`${$(w)}::text <<% t.search_text`);
    else base.push(`t.search_text LIKE ${$(likeArg(w))}`);
  }
  if (p.fuzzy) {
    const fz = ws.filter(w => w.length >= FUZZY_MIN_LEN);
    if (fz.length) rank = fz.map(w => `strict_word_similarity(${$(w)}::text, t.search_text)`).join(' + ');
  }
  const nearAt = () => {
    const [lat, lon, km] = p.near;
    const pt = `ST_SetSRID(ST_MakePoint(${$(lon)}, ${$(lat)}), 4326)`;
    // Box prefilter on the narrow table's indexed box (degrees, generous), then the exact distance to the line
    const deg = $(km / 111 / Math.max(0.2, Math.cos(lat * Math.PI / 180)) + 0.01);
    // Distance to the 15 m simplified line: thousands of times cheaper than the full one, within 15 m of it
    return [`t.box && ST_Expand(${pt}, ${deg})`,
            `ST_DWithin((SELECT s.geom_s1 FROM tracks s WHERE s.id = t.id)::geography, ${pt}::geography, ${$(km * 1000)})`];
  };
  let nearSql = null;
  if (p.near) {
    nearSql = `SELECT t.id FROM track_search t WHERE ${[...vis, ...nearAt()].join(' AND ')}`;
    if (nearIds) base.push(`t.id = ANY(${$(nearIds)}::int[])`);
    else base.push(...nearAt());
  }
  if (p.gradeActive) base.push(`t.grade BETWEEN ${$(p.gradeMin ?? 0)} AND ${$(p.gradeMax ?? 5)}`);
  if (p.rtype.length === 1) base.push(p.rtype[0] === 'circular' ? `t.circular` : `NOT t.circular`);
  if (p.mine) base.push(`t.owner_id = ${me}`);
  if (p.users.length) base.push(`t.owner_id = ANY(${$(p.users)}::int[])`);

  const actC = !p.acts.length ? 'TRUE'
    : p.acts.includes('Sin clasificar') ? `(t.activity = ANY(${$(p.acts)}::text[]) OR t.activity IS NULL)`
    : `t.activity = ANY(${$(p.acts)}::text[])`;
  const sierraC = p.sierras.length ? `t.sierra = ANY(${$(p.sierras)}::text[])` : 'TRUE';
  const tagC = p.tags.length ? `t.tags && ${$(p.tags)}::text[]` : 'TRUE';
  let boxC = 'TRUE';
  if (p.bbox) {
    const [w, s, e, n] = p.bbox;
    // Bounding boxes overlap, like the visor's bounds.intersects(). The box of geom_s1 (indexed) stands in for
    // the route: at most the 15 m tolerance smaller (and, for the owner, without the privacy zone)
    boxC = `t.box && ST_MakeEnvelope(${$(w)}, ${$(s)}, ${$(e)}, ${$(n)}, 4326)`;
  }
  const baseSql = base.join(' AND ');
  return {
    args, geom, full, boxC, nearSql, rank,
    base: baseSql, actC, sierraC, tagC,
    where: `${baseSql} AND ${actC} AND ${sierraC} AND ${tagC} AND ${boxC}`,
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

async function searchOnce(db, p, viewer, { dataVersion = null, lite = false, serial = false } = {}) {
  // The radius filter (distance to the line) is the one expensive predicate: evaluate it once
  let nearIds = null;
  if (p.near) {
    const s0 = buildSearchSql(p, viewer);
    nearIds = (await db.all(...bind(s0.nearSql, s0.args))).map(r => r.id);
  }
  const s = buildSearchSql(p, viewer, { nearIds });
  const all = sql => db.all(...bind(sql, s.args));
  const get = sql => db.get(...bind(sql, s.args));
  // Fuzzy results without an explicit sort come best match first
  const byRank = p.fuzzy && s.rank && p.sort === 'name';
  const order = `${byRank ? `(${s.rank}) DESC, ` : ''}${SORTS[p.sort] || SORTS.name}, ${TIEBREAK}`;

  const totalsQ = lite ? () => ({ n: 0, km: 0, gain: 0 }) : () => get(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n, COALESCE(SUM(d), 0) AS km, COALESCE(SUM(g), 0) AS gain
     FROM (SELECT t.distance AS d, t.elevation_gain AS g FROM track_search t WHERE ${s.where} LIMIT ${COUNT_CAP + 1}) x`);
  // The page is chosen on the narrow table; the full rows and geometries of its ≤60 routes come from tracks
  const sortCols = `t.name, t.date, t.distance, t.elevation_gain, t.ibp_sort${byRank ? `, (${s.rank}) AS rank` : ''}`;
  const outer = `${byRank ? 'pg.rank DESC, ' : ''}${(SORTS[p.sort] || SORTS.name).replace(/\bt\./g, 'pg.')}, ${TIEBREAK.replace(/\bt\./g, 'pg.')}`;
  const itemsQ = () => all(
    `WITH pg AS (SELECT t.id, ${sortCols} FROM track_search t WHERE ${s.where} ORDER BY ${order} LIMIT ${p.size} OFFSET ${p.page * p.size})
     SELECT tr.id, tr.name, tr.date, tr.activity, tr.sierra, tr.ccaa, tr.tags, tr.distance, tr.elevation_gain, tr.elevation_loss,
            tr.min_elevation, tr.max_elevation, tr.ibp_bicycle, tr.ibp_hiking, tr.ibp_running, tr.difficulty, tr.moving_time, tr.stopped_time,
            tr.circular, tr.owner_id, tr.visibility, tr.cover_photo_id, tr.road_types, tr.file, u.username AS owner_username,
            ST_AsGeoJSON(ST_StartPoint(${s.geom}), 5) AS start,
            ST_AsGeoJSON(CASE WHEN ${s.full} THEN ST_Transform(ST_Simplify(ST_Transform(tr.geom, 3857),
                                ${TOL[p.line]} / cos(radians(ST_Y(ST_Centroid(tr.geom)))), true), 4326)
                              ELSE tr.geom_${p.line} END, 5) AS line,
            ST_XMin(${s.geom}) AS w, ST_YMin(${s.geom}) AS s, ST_XMax(${s.geom}) AS e, ST_YMax(${s.geom}) AS n
     FROM pg JOIN tracks tr ON tr.id = pg.id LEFT JOIN users u ON u.id = tr.owner_id
     ORDER BY ${outer}`);
  const startsQ = p.starts && !lite
    ? () => all(`SELECT tr.id, tr.activity, ST_Y(ST_StartPoint(${s.geom})) AS lat, ST_X(ST_StartPoint(${s.geom})) AS lon
              FROM (SELECT t.id FROM track_search t WHERE ${s.where} LIMIT 5000) x JOIN tracks tr ON tr.id = x.id`)
    : null;

  const key = facetKey(p, viewer, dataVersion);
  const cached = lite ? null : dataVersion != null ? _facetCache.get(key) : null;
  let facetsQ = lite ? null : cached ? () => cached : null;
  if (!facetsQ && !lite) {
    // One pass over the matches (without box/pill filters), then the three cascading counts from it
    facetsQ = () => all(
      `WITH c AS MATERIALIZED (
         SELECT t.activity, t.sierra, t.tags, ${s.actC} AS a_ok, ${s.sierraC} AS s_ok, ${s.tagC} AS t_ok
         FROM track_search t WHERE ${s.base})
       SELECT 'a' AS kind, COALESCE(activity, 'Sin clasificar') AS k, CAST(COUNT(*) AS INTEGER) AS n FROM c WHERE s_ok AND t_ok GROUP BY 2
       UNION ALL
       SELECT 's', sierra, CAST(COUNT(*) AS INTEGER) FROM c WHERE sierra IS NOT NULL AND sierra <> '' AND a_ok AND t_ok GROUP BY 2
       UNION ALL
       SELECT 'g', tg, CAST(COUNT(*) AS INTEGER) FROM c CROSS JOIN LATERAL unnest(c.tags) tg WHERE a_ok AND s_ok GROUP BY 2`)
      .then(rows => {
        const f = { activity: {}, sierra: {}, tags: {} };
        for (const r of rows) f[r.kind === 'a' ? 'activity' : r.kind === 's' ? 'sierra' : 'tags'][r.k] = r.n;
        return f;
      });
    if (dataVersion != null && !serial) {
      const pending = facetsQ();
      facetsQ = () => pending;
      _facetCache.set(key, pending);
      pending.catch(() => _facetCache.delete(key));
      if (_facetCache.size > FACETS_CACHE_MAX) _facetCache.delete(_facetCache.keys().next().value);
    }
  }

  // One client runs one query at a time: inside a transaction (fuzzy mode) they go in turn
  const jobs = [totalsQ, itemsQ, startsQ, facetsQ].map(f => f || (() => null));
  let totals, rows, starts, facets;
  if (serial) { const out = []; for (const f of jobs) out.push(await f()); [totals, rows, starts, facets] = out; }
  else [totals, rows, starts, facets] = await Promise.all(jobs.map(f => f()));
  const coords = g => { try { return JSON.parse(g).coordinates; } catch { return null; } };
  const r0 = v => (v != null ? Math.round(v) : null);
  const items = rows.map(t => {
    const st = coords(t.start);
    const line = coords(t.line);
    let tags = [];
    try { tags = t.tags ? JSON.parse(t.tags) : []; } catch {}
    return {
      id: t.id, file: t.file, name: t.name, date: t.date, activity: t.activity || null, sierra: t.sierra || null, ccaa: t.ccaa || null, tags,
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
  if (lite) return { items };
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

/** Exact search; if the text finds nothing at all (not only in this box) it is repeated by similarity. */
async function runSearch(db, p, viewer, opts = {}) {
  const out = await searchOnce(db, p, viewer, opts);
  if (opts.lite || !p.q || out.total > 0 || p.fuzzy) return out;
  // Matches outside the visible box mean the text is right: the box is just empty
  const s = buildSearchSql({ ...p, bbox: null }, viewer);
  const outside = await db.get(...bind(`SELECT 1 AS x FROM track_search t WHERE ${s.base} AND ${s.actC} AND ${s.sierraC} AND ${s.tagC} LIMIT 1`, s.args));
  if (outside) return out;
  const fp = { ...p, fuzzy: true };
  // strict_word_similarity_threshold is a session setting: the queries run in one transaction that sets it
  const fz = typeof db.tx === 'function'
    ? await db.tx(async d => { await d.exec(`SET LOCAL pg_trgm.strict_word_similarity_threshold = ${FUZZY_THRESHOLD}`); return searchOnce(d, fp, viewer, { ...opts, serial: true }); })
    : await searchOnce(db, fp, viewer, opts);
  return fz.total > 0 ? { ...fz, fuzzy: true } : out;
}

// Data the visor used to derive from the whole catalog: years, owners, slider maxima and a robust
// "where most routes are" box (5th–95th percentile, so a few far-away outliers don't zoom the map out).
// Depends only on the viewer and the data, so it is cached per data version.
const _metaCache = new Map();
async function runMeta(db, viewer, { dataVersion = null } = {}) {
  const key = JSON.stringify([dataVersion, viewer.sub, viewer.role === 'admin']);
  if (dataVersion != null && _metaCache.has(key)) return _metaCache.get(key);
  const q = (async () => {
    const s = buildSearchSql(parseSearchParams(new URLSearchParams()), viewer);
    const all = sql => db.all(...bind(sql, s.args));
    const [years, owners, mx, core] = await Promise.all([
      all(`SELECT DISTINCT substr(t.date, 1, 4) AS y FROM track_search t WHERE ${s.base} AND t.date ~ '^[0-9]{4}' ORDER BY 1 DESC`),
      all(`SELECT t.owner_id AS id, u.username, CAST(COUNT(*) AS INTEGER) AS n FROM track_search t JOIN users u ON u.id = t.owner_id
           WHERE ${s.base} GROUP BY 1, 2 ORDER BY u.username COLLATE "es-x-icu"`),
      db.get(...bind(`SELECT MAX(t.distance) AS d, MAX(t.elevation_gain) AS e FROM track_search t WHERE ${s.base}`, s.args)),
      db.get(...bind(`SELECT percentile_cont(0.05) WITHIN GROUP (ORDER BY ST_YMin(t.box)) AS s, percentile_cont(0.05) WITHIN GROUP (ORDER BY ST_XMin(t.box)) AS w,
                             percentile_cont(0.95) WITHIN GROUP (ORDER BY ST_YMax(t.box)) AS n, percentile_cont(0.95) WITHIN GROUP (ORDER BY ST_XMax(t.box)) AS e
                      FROM track_search t WHERE ${s.base}`, s.args)),
    ]);
    return {
      years: years.map(r => r.y),
      owners: owners.map(r => ({ id: r.id, username: r.username, n: r.n })),
      maxDist: mx?.d != null ? Number(mx.d) : 0, maxEle: mx?.e != null ? Number(mx.e) : 0,
      core: core && core.s != null ? [[Number(core.s), Number(core.w)], [Number(core.n), Number(core.e)]] : null,
    };
  })();
  if (dataVersion != null) {
    _metaCache.set(key, q);
    q.catch(() => _metaCache.delete(key));
    if (_metaCache.size > FACETS_CACHE_MAX) _metaCache.delete(_metaCache.keys().next().value);
  }
  return q;
}

module.exports = { parseSearchParams, buildSearchSql, runSearch, runMeta, bind, SORTS, COUNT_CAP, CYCLING, RUNNING, FUZZY_THRESHOLD };
