#!/usr/bin/env node
'use strict';
// Descarga datos Overpass por sierra y, por defecto, aplica el enriquecimiento
// a todos los tracks de cada zona en el mismo paso.
// Uso: node scripts/osm-precache.js [--force] [--cache-only] [--enrich-only] [--missing-only] [--sierra X]
//   --force        : re-descarga aunque la caché sea reciente
//   --cache-only   : solo guarda la caché, no modifica los tracks
//   --enrich-only  : solo enriquece desde caché existente, sin consultar Overpass
//   --missing-only : descarga caché solo de zonas que aún no la tienen
//   --sierra X     : procesa solo ese grupo

const fs   = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { queryOverpass, filterWaysToBbox, fetchTrackPts, applyWaysToTrack, sleep } = require('./osm-shared');
const { CACHE_DIR, slugify } = require('./osm-strategy-batch');

const DELAY_MS     = 2500;
const MAX_BBOX_DEG = 3.5;

async function main() {
  const args        = process.argv.slice(2);
  const force       = args.includes('--force');
  const cacheOnly   = args.includes('--cache-only') || args.includes('--missing-only');
  const enrichOnly  = args.includes('--enrich-only');
  const missingOnly = args.includes('--missing-only');
  const sierraIdx   = args.indexOf('--sierra');
  const sierraArg   = sierraIdx !== -1 ? args[sierraIdx + 1] : null;

  const db = openDb();

  let cacheTtlMs = 30 * 86400 * 1000;
  try {
    const sf = path.join(__dirname, '..', 'osm-settings.json');
    if (fs.existsSync(sf)) {
      const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
      if (s.cacheTtlDays) cacheTtlMs = s.cacheTtlDays * 86400 * 1000;
    }
  } catch {}

  // Aggregate bbox + track ids per group (sierra → province → 'sin-zona')
  const rows = db.prepare(`
    SELECT
      COALESCE(sierra, province, 'sin-zona') AS group_key,
      MIN(sw_lat) AS s, MIN(sw_lon) AS w,
      MAX(ne_lat) AS n, MAX(ne_lon) AS e,
      COUNT(*)    AS track_count
    FROM tracks
    WHERE sw_lat IS NOT NULL
    GROUP BY COALESCE(sierra, province, 'sin-zona')
    ORDER BY track_count DESC
  `).all();

  const groups = sierraArg
    ? rows.filter(r => r.group_key.toLowerCase() === sierraArg.toLowerCase())
    : rows;

  const mode = enrichOnly ? 'solo enriquecer desde caché' : cacheOnly ? 'solo caché' : 'caché + enriquecimiento';
  console.log(`\nProcesando ${groups.length} grupos (${mode})…`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let enriched = 0, cachedGroups = 0, skipped = 0, failed = 0;

  for (let i = 0; i < groups.length; i++) {
    const g    = groups[i];
    const file = path.join(CACHE_DIR, slugify(g.group_key) + '.json');

    // --missing-only: skip groups that already have a valid cache file
    if (missingOnly && fs.existsSync(file)) {
      console.log(`[${i+1}/${groups.length}] ${g.group_key} — ya tiene caché, saltando`);
      skipped++;
      continue;
    }

    // --enrich-only: only use existing cache, never query Overpass
    if (enrichOnly) {
      if (!fs.existsSync(file)) {
        console.log(`[${i+1}/${groups.length}] ${g.group_key} — sin caché, saltando`);
        skipped++;
        continue;
      }
      let ways;
      try {
        ways = JSON.parse(fs.readFileSync(file, 'utf8')).ways || [];
      } catch {
        console.log(`[${i+1}/${groups.length}] ${g.group_key} — error leyendo caché, saltando`);
        skipped++;
        continue;
      }
      const ageH = (() => { try { return Math.round((Date.now() - JSON.parse(fs.readFileSync(file,'utf8')).ts) / 3600000); } catch { return '?'; } })();
      const osmFilter = force ? '' : "AND (road_types IS NULL OR road_types = '{}')";
      const tracks = db.prepare(
        `SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon
         FROM tracks WHERE COALESCE(sierra, province, 'sin-zona') = ? AND sw_lat IS NOT NULL ${osmFilter}`
      ).all(g.group_key);
      console.log(`[${i+1}/${groups.length}] ${g.group_key} — caché ${ageH}h — ${tracks.length}/${g.track_count} pendientes`);
      if (tracks.length === 0) {
        console.log('  ✓ Todos los tracks ya tienen datos OSM');
        cachedGroups++;
        continue;
      }
      let groupOk = 0;
      for (let j = 0; j < tracks.length; j++) {
        const t = tracks[j];
        console.log(`  [${j+1}/${tracks.length}] ${t.name}`);
        const pts = fetchTrackPts(t, db);
        if (pts.length < 2) { console.log('    ⚠ Sin puntos'); continue; }
        const filtered = filterWaysToBbox(ways, t);
        console.log(`    ${filtered.length} caminos cercanos`);
        applyWaysToTrack(t, pts, filtered, db);
        groupOk++;
      }
      console.log(`  ✓ ${groupOk} tracks enriquecidos`);
      enriched += groupOk;
      cachedGroups++;
      continue;
    }

    // Normal flow: determine whether we need a fresh Overpass query
    let ways = null;
    let fromCache = false;

    if (!force && fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (d.ts && (Date.now() - d.ts) < cacheTtlMs) {
          ways = d.ways;
          fromCache = true;
          const ageH = Math.round((Date.now() - d.ts) / 3600000);
          console.log(`[${i+1}/${groups.length}] ${g.group_key} (${g.track_count} tracks) — caché vigente (${ageH}h)`);
          cachedGroups++;
        }
      } catch {}
    }

    if (!ways) {
      const latSpan = g.n - g.s;
      const lonSpan = g.e - g.w;
      if (latSpan > MAX_BBOX_DEG || lonSpan > MAX_BBOX_DEG) {
        console.log(`[${i+1}/${groups.length}] ${g.group_key} — bbox demasiado grande (${latSpan.toFixed(2)}°×${lonSpan.toFixed(2)}°), saltando`);
        skipped++;
        continue;
      }

      const buf = 0.008;
      console.log(`[${i+1}/${groups.length}] ${g.group_key} (${g.track_count} tracks) — consultando Overpass…`);
      try {
        const osmData = await queryOverpass(g.s - buf, g.w - buf, g.n + buf, g.e + buf);
        ways = (osmData.elements || []).filter(el => el.type === 'way' && el.tags?.highway);
        fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), ways }));
        console.log(`  ${ways.length} caminos guardados en caché`);
      } catch (err) {
        console.log(`  ✗ Overpass: ${err.message}`);
        failed++;
        if (i < groups.length - 1) await sleep(DELAY_MS);
        continue;
      }
    }

    // Apply to tracks unless --cache-only
    if (!cacheOnly) {
      const osmFilter2 = force ? '' : "AND (road_types IS NULL OR road_types = '{}')";
      const tracks = db.prepare(`
        SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon
        FROM tracks
        WHERE COALESCE(sierra, province, 'sin-zona') = ? AND sw_lat IS NOT NULL ${osmFilter2}
      `).all(g.group_key);
      if (tracks.length === 0) {
        console.log('  ✓ Todos los tracks ya tienen datos OSM');
        continue;
      }
      console.log(`  ${tracks.length}/${g.track_count} tracks pendientes`);

      let groupOk = 0;
      for (let j = 0; j < tracks.length; j++) {
        const t = tracks[j];
        console.log(`  [${j+1}/${tracks.length}] ${t.name}`);
        const pts = fetchTrackPts(t, db);
        if (pts.length < 2) { console.log('    ⚠ Sin puntos'); continue; }
        const filtered = filterWaysToBbox(ways, t);
        console.log(`    ${filtered.length} caminos cercanos`);
        applyWaysToTrack(t, pts, filtered, db);
        groupOk++;
      }
      console.log(`  ✓ ${groupOk} tracks enriquecidos`);
      enriched += groupOk;
    }

    if (!fromCache && i < groups.length - 1) await sleep(DELAY_MS);
  }

  if (cacheOnly) {
    console.log(`\n✓ Caché descargada: ${groups.length - skipped - failed} zonas, ${skipped} saltadas, ${failed} fallidas\n`);
  } else {
    console.log(`\n✓ Completado: ${enriched} tracks enriquecidos, ${cachedGroups} zonas ya en caché, ${skipped} saltadas, ${failed} fallidas\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
