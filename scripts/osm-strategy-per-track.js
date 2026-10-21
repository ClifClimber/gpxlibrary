'use strict';
// Método 1: una consulta Overpass por track (comportamiento original).

const { queryOverpass, fetchTrackPts, applyWaysToTrack, sleep } = require('./osm-shared');

const DELAY_MS     = 2500;
const MAX_BBOX_DEG = 3.0;
const MAX_PTS      = 1500;

async function enrichTracks(tracks, db) {
  let ok = 0, fail = 0;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    console.log(`[${i+1}/${tracks.length}] ${t.name}`);

    if (!t.sw_lat) { console.log('  ⚠ Sin bbox, saltando'); fail++; continue; }

    const latSpan = t.ne_lat - t.sw_lat;
    const lonSpan = t.ne_lon - t.sw_lon;
    if (latSpan > MAX_BBOX_DEG || lonSpan > MAX_BBOX_DEG) {
      console.log(`  ⚠ Bbox muy grande (${latSpan.toFixed(2)}°×${lonSpan.toFixed(2)}°), saltando`);
      fail++;
      continue;
    }

    const pts = fetchTrackPts(t, db, MAX_PTS);
    if (pts.length < 2) { console.log('  ⚠ Sin puntos'); fail++; continue; }

    const buf = 0.008;
    let osmData;
    try {
      osmData = await queryOverpass(t.sw_lat - buf, t.sw_lon - buf, t.ne_lat + buf, t.ne_lon + buf);
    } catch (err) {
      console.log(`  ✗ Overpass: ${err.message}`);
      fail++;
      if (i < tracks.length - 1) await sleep(DELAY_MS);
      continue;
    }

    const ways = (osmData.elements || []).filter(el => el.type === 'way' && el.tags?.highway);
    console.log(`  OSM: ${ways.length} caminos`);
    applyWaysToTrack(t, pts, ways, db);
    ok++;

    if (i < tracks.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n✓ Completado: ${ok} ok, ${fail} fallidos\n`);
}

module.exports = { enrichTracks };
