#!/usr/bin/env node
'use strict';
// Rellena la columna catalog_pts para todos los tracks que aún no la tienen.
// Uso: node scripts/backfill-catalog-pts.js

const { openSql } = require('../repo/sql');
const { catalogPts } = require('../domain');

const MAX_CATALOG_PTS = 300;

(async () => {
  const db = openSql();
  const tracks = await db.all('SELECT id, cleaned FROM tracks WHERE catalog_pts IS NULL AND sw_lat IS NOT NULL ORDER BY id');
  if (!tracks.length) {
    console.log('\nTodos los tracks ya tienen catalog_pts.\n');
    await db.close();
    return;
  }
  console.log(`\nRellenando catalog_pts para ${tracks.length} tracks...`);
  let ok = 0, skip = 0;
  for (const t of tracks) {
    const cp = catalogPts(await db.getPoints(t.id, { clean: !!t.cleaned }), MAX_CATALOG_PTS);
    if (!cp) { skip++; continue; }
    await db.run('UPDATE tracks SET catalog_pts=? WHERE id=?', [cp, t.id]);
    ok++;
    if (ok % 25 === 0) process.stdout.write(`\r  ${ok}/${tracks.length}...`);
  }
  console.log(`\r✓ ${ok} tracks actualizados${skip ? `, ${skip} sin puntos` : ''}.\n`);
  await db.close();
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
