#!/usr/bin/env node
'use strict';
// Fills tracks.elapsed_time (first → last timestamp) and tracks.time_segments (recording sessions,
// used to count days with activity) for tracks imported before those columns existed. Reads each
// original GPX from the store. Tracks without timestamps stay NULL.
// Usage: node scripts/backfill-elapsed.js [--all]   (--all recomputes every track)
const { openSql } = require('../repo/sql');
const { readTrackFile, gpxText } = require('./store');
const { parseGpx, elapsedSeconds, timeSegments } = require('../domain');

const ALL = process.argv.includes('--all');

(async () => {
  const db = openSql();
  const tracks = await db.all(`SELECT id, name, file FROM tracks ${ALL ? '' : 'WHERE time_segments IS NULL'} ORDER BY id`);
  console.log(`Calculando tiempos de ${tracks.length} ruta(s)…`);
  let withTime = 0, noTime = 0, errors = 0, done = 0;
  for (const t of tracks) {
    try {
      const buf = await readTrackFile(t.file);
      if (!buf) throw new Error('GPX no encontrado en el almacén');
      const pts = parseGpx(gpxText(buf), { fileName: t.file }).points;
      const s = elapsedSeconds(pts), segs = timeSegments(pts);
      if (s && segs) { await db.run('UPDATE tracks SET elapsed_time = ?, time_segments = ? WHERE id = ?', [s, JSON.stringify(segs), t.id]); withTime++; }
      else noTime++;
    } catch (e) {
      errors++;
      console.log(`⚠ #${t.id} ${t.name}: ${e.message}`);
    }
    if (++done % 50 === 0) console.log(`  … ${done} / ${tracks.length}`);
  }
  console.log(`✓ Con tiempo: ${withTime} · sin marcas de tiempo: ${noTime} · errores: ${errors}`);
  process.exit(errors && !withTime ? 1 : 0);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
