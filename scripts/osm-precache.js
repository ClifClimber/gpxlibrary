#!/usr/bin/env node
'use strict';
// Pre-calienta la caché batch-sierra consultando Overpass para cada grupo
// de tracks sin necesidad de ejecutar el enriquecimiento completo.
// Uso: node scripts/osm-precache.js [--force] [--sierra "Sierra de Guadarrama"]

const fs   = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { queryOverpass, sleep } = require('./osm-shared');
const { CACHE_DIR, slugify } = require('./osm-strategy-batch');

const DELAY_MS     = 2500;
const MAX_BBOX_DEG = 3.5;

async function main() {
  const args       = process.argv.slice(2);
  const force      = args.includes('--force');
  const sierraIdx  = args.indexOf('--sierra');
  const sierraArg  = sierraIdx !== -1 ? args[sierraIdx + 1] : null;

  const db = openDb();

  // Load settings for TTL
  let cacheTtlMs = 30 * 86400 * 1000;
  try {
    const sf = path.join(__dirname, '..', 'osm-settings.json');
    if (fs.existsSync(sf)) {
      const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
      if (s.cacheTtlDays) cacheTtlMs = s.cacheTtlDays * 86400 * 1000;
    }
  } catch {}

  // Aggregate bbox per group_key (sierra → province → 'sin-zona')
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

  console.log(`\nPre-calentando caché OSM para ${groups.length} grupos…`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let cached = 0, queried = 0, skipped = 0, failed = 0;

  for (let i = 0; i < groups.length; i++) {
    const g    = groups[i];
    const file = path.join(CACHE_DIR, slugify(g.group_key) + '.json');

    // Skip if cache is fresh and --force not set
    if (!force && fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (d.ts && (Date.now() - d.ts) < cacheTtlMs) {
          const ageH = Math.round((Date.now() - d.ts) / 3600000);
          console.log(`[${i+1}/${groups.length}] ${g.group_key} — caché vigente (${ageH}h), saltando`);
          cached++;
          continue;
        }
      } catch {}
    }

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
      const ways = (osmData.elements || []).filter(el => el.type === 'way' && el.tags?.highway);
      fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), ways }));
      console.log(`  ✓ ${ways.length} caminos guardados`);
      queried++;
    } catch (err) {
      console.log(`  ✗ Overpass: ${err.message}`);
      failed++;
    }

    if (i < groups.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n✓ Completado: ${queried} consultados, ${cached} ya en caché, ${skipped} saltados, ${failed} fallidos\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
