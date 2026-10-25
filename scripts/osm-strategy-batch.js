'use strict';
// Método 2: batch por sierra — una consulta Overpass por grupo de tracks,
// resultado cacheado en data/osm-cache/{sierra-slug}.json (TTL configurable).

const fs   = require('fs');
const path = require('path');
const { queryOverpass, filterWaysToBbox, fetchTrackPts, applyWaysToTrack, sleep } = require('./osm-shared');

const DELAY_MS     = 2500;
const MAX_BBOX_DEG = 3.5; // más tolerante para grupos
const MAX_PTS      = 1500;
const CACHE_DIR    = path.join(__dirname, '..', 'data', 'osm-cache');

function slugify(s) {
  return (s || 'sin-zona')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readCache(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (d.ts && d.ways) ? d : null;
  } catch { return null; }
}

// Enriches each track in the fallback list individually via Overpass.
async function perTrackFallback(groupTracks, db) {
  let ok = 0, fail = 0;
  for (let i = 0; i < groupTracks.length; i++) {
    const t = groupTracks[i];
    console.log(`  [${i+1}/${groupTracks.length}] ${t.name}`);
    if (!t.sw_lat) { console.log('    ⚠ Sin bbox'); fail++; continue; }
    const buf = 0.008;
    try {
      const osmData = await queryOverpass(t.sw_lat - buf, t.sw_lon - buf, t.ne_lat + buf, t.ne_lon + buf);
      const ways = (osmData.elements || []).filter(el => el.type === 'way' && el.tags?.highway);
      console.log(`    OSM: ${ways.length} caminos`);
      const pts = await fetchTrackPts(t, db, MAX_PTS);
      if (pts.length < 2) { console.log('    ⚠ Sin puntos'); fail++; continue; }
      await applyWaysToTrack(t, pts, filterWaysToBbox(ways, t), db);
      ok++;
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
      fail++;
    }
    if (i < groupTracks.length - 1) await sleep(DELAY_MS);
  }
  return { ok, fail };
}

async function enrichTracks(tracks, db, opts = {}) {
  const cacheTtlMs = (opts.cacheTtlDays ?? 30) * 86400 * 1000;
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Group by sierra → province → 'sin-zona'
  const groups = new Map();
  for (const t of tracks) {
    const key = t.sierra || t.province || 'sin-zona';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  let totalOk = 0, totalFail = 0;
  let groupIdx = 0;

  for (const [groupKey, groupTracks] of groups) {
    groupIdx++;
    console.log(`\n── Grupo ${groupIdx}/${groups.size}: ${groupKey} (${groupTracks.length} tracks)`);

    // Union bbox for tracks in this group that have coordinates
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    let withBbox = 0;
    for (const t of groupTracks) {
      if (!t.sw_lat) continue;
      withBbox++;
      if (t.sw_lat < minLat) minLat = t.sw_lat;
      if (t.sw_lon < minLon) minLon = t.sw_lon;
      if (t.ne_lat > maxLat) maxLat = t.ne_lat;
      if (t.ne_lon > maxLon) maxLon = t.ne_lon;
    }

    if (withBbox === 0) {
      console.log('  ⚠ Ningún track con bbox, saltando');
      totalFail += groupTracks.length;
      continue;
    }

    const latSpan = maxLat - minLat;
    const lonSpan = maxLon - minLon;
    if (latSpan > MAX_BBOX_DEG || lonSpan > MAX_BBOX_DEG) {
      console.log(`  ⚠ Bbox de grupo demasiado grande (${latSpan.toFixed(2)}°×${lonSpan.toFixed(2)}°) — usando per-track`);
      const { ok, fail } = await perTrackFallback(groupTracks, db);
      totalOk += ok; totalFail += fail;
      if (groupIdx < groups.size) await sleep(DELAY_MS);
      continue;
    }

    // Load cache or query Overpass
    const cacheFile = path.join(CACHE_DIR, slugify(groupKey) + '.json');
    let ways;
    const cached = readCache(cacheFile);

    if (cached && (Date.now() - cached.ts) < cacheTtlMs) {
      ways = cached.ways;
      const ageH = Math.round((Date.now() - cached.ts) / 3600000);
      console.log(`  Caché: ${ways.length} caminos (${ageH}h antiguo)`);
    } else {
      const buf = 0.008;
      const s = minLat - buf, w = minLon - buf, n = maxLat + buf, e = maxLon + buf;
      console.log(`  Overpass: bbox ${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)}`);
      try {
        const osmData = await queryOverpass(s, w, n, e);
        ways = (osmData.elements || []).filter(el => el.type === 'way' && el.tags?.highway);
        fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), ways }));
        console.log(`  ${ways.length} caminos — guardado en caché`);
      } catch (err) {
        console.log(`  ✗ Overpass: ${err.message}`);
        totalFail += groupTracks.length;
        if (groupIdx < groups.size) await sleep(DELAY_MS);
        continue;
      }
    }

    // Apply ways to each track in the group (filtered to track bbox for performance)
    for (let i = 0; i < groupTracks.length; i++) {
      const t = groupTracks[i];
      console.log(`  [${i+1}/${groupTracks.length}] ${t.name}`);
      const pts = await fetchTrackPts(t, db, MAX_PTS);
      if (pts.length < 2) { console.log('    ⚠ Sin puntos'); totalFail++; continue; }
      await applyWaysToTrack(t, pts, filterWaysToBbox(ways, t), db);
      totalOk++;
    }

    if (groupIdx < groups.size) await sleep(DELAY_MS);
  }

  console.log(`\n✓ Completado: ${totalOk} ok, ${totalFail} fallidos\n`);
}

module.exports = { enrichTracks, CACHE_DIR, slugify };
