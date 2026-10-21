#!/usr/bin/env node
'use strict';
// Rellena la columna catalog_pts para todos los tracks que aún no la tienen.
// Uso: node scripts/backfill-catalog-pts.js

const { openDb, withTransaction } = require('./db');

const MAX_CATALOG_PTS = 300;
function catalogPts(pts) {
  if (!pts || pts.length < 2) return null;
  const n = Math.min(pts.length, MAX_CATALOG_PTS);
  const step = (pts.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[Math.round(i * step)];
    out.push([Math.round(p.lat*100000)/100000, Math.round(p.lon*100000)/100000, p.ele!=null?Math.round(p.ele):null]);
  }
  return JSON.stringify(out);
}

const db = openDb();

const tracks = db.prepare(
  'SELECT id, cleaned FROM tracks WHERE catalog_pts IS NULL AND sw_lat IS NOT NULL'
).all();

if (!tracks.length) {
  console.log('\nTodos los tracks ya tienen catalog_pts.\n');
  process.exit(0);
}

console.log(`\nRellenando catalog_pts para ${tracks.length} tracks...`);

const fetchRaw   = db.prepare('SELECT lat,lon,ele FROM raw_points   WHERE track_id=? ORDER BY seq');
const fetchClean = db.prepare('SELECT lat,lon,ele FROM clean_points WHERE track_id=? ORDER BY seq');
const updPts     = db.prepare('UPDATE tracks SET catalog_pts=? WHERE id=?');

let ok = 0, skip = 0;

for (const t of tracks) {
  const pts = t.cleaned ? fetchClean.all(t.id) : fetchRaw.all(t.id);
  const cp = catalogPts(pts);
  if (!cp) { skip++; continue; }
  updPts.run(cp, t.id);
  ok++;
  if (ok % 25 === 0) process.stdout.write(`\r  ${ok}/${tracks.length}...`);
}

console.log(`\r✓ ${ok} tracks actualizados${skip ? `, ${skip} sin puntos` : ''}.\n`);
