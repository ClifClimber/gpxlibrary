#!/usr/bin/env node
'use strict';
// Computes the derived data of each route: geom_view (what other people see: clean-or-raw geometry minus the
// owner's privacy zones), geom_s1 / geom_s2 (simplified), start_point, search_text and derived_at.
// Usage: node scripts/track-derive.js (--ids 1,2,3 | --all | --owner <userId> | --missing)
const { openSql } = require('../repo/sql');
const { lineParams } = require('../repo/postgres');
const { visiblePoints, searchText, DERIVE_TOLERANCES } = require('../domain');

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const BATCH = 200;

(async () => {
  const db = openSql();
  let where, params = [];
  if (opt('ids') !== undefined) {
    const ids = opt('ids').split(',').map(Number).filter(Number.isInteger);
    where = 't.id = ANY(?::int[])'; params = [ids];
  } else if (opt('owner') !== undefined) { where = 't.owner_id = ?'; params = [Number(opt('owner'))]; }
  else if (argv.includes('--all')) where = 'TRUE';
  else if (argv.includes('--missing')) where = 't.derived_at IS NULL';
  else { console.error('Uso: track-derive.js --ids 1,2 | --all | --owner <id> | --missing'); process.exit(2); }

  const rows = await db.all(`SELECT t.id FROM tracks t WHERE ${where} ORDER BY t.id`, params);
  console.log(`Calculando geometrías derivadas de ${rows.length} ruta(s)…`);
  let done = 0, empty = 0, errors = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const ids = rows.slice(i, i + BATCH).map(r => r.id);
    const tracks = await db.all(
      `SELECT t.id, t.name, t.sierra, t.province, t.tags, t.cleaned, COALESCE(u.privacy_radius, 0) AS radius
         FROM tracks t LEFT JOIN users u ON u.id = t.owner_id WHERE t.id = ANY(?::int[])`, [ids]);
    for (const t of tracks) {
      try {
        let pts = await db.getPoints(t.id, { clean: !!t.cleaned });
        if (!pts.length && t.cleaned) pts = await db.getPoints(t.id);
        const vis = visiblePoints(pts, Number(t.radius) || 0, t.id);
        const wkt = vis.length >= 2 ? lineParams(vis)[0] : null;
        if (!wkt) empty++;
        await db.run(
          `UPDATE tracks SET geom_view = CASE WHEN ?::text IS NULL THEN NULL ELSE ST_GeomFromText(?::text, 4326) END,
                  search_text = ?, derived_at = now() WHERE id = ?`, [wkt, wkt, searchText(t), t.id]);
        await db.run(
          `UPDATE tracks SET
             -- Tolerances are real metres: 3857 stretches distances by 1/cos(latitude), so they are scaled likewise
             geom_s1 = CASE WHEN geom_view IS NULL THEN NULL ELSE ST_Transform(ST_Simplify(ST_Transform(geom_view, 3857),
                         ?::float8 / cos(radians(ST_Y(ST_Centroid(geom_view)))), true), 4326) END,
             geom_s2 = CASE WHEN geom_view IS NULL THEN NULL ELSE ST_Transform(ST_Simplify(ST_Transform(geom_view, 3857),
                         ?::float8 / cos(radians(ST_Y(ST_Centroid(geom_view)))), true), 4326) END,
             start_point = CASE WHEN geom_view IS NULL THEN NULL ELSE ST_StartPoint(geom_view) END
           WHERE id = ?`, [DERIVE_TOLERANCES.s1, DERIVE_TOLERANCES.s2, t.id]);
      } catch (e) { errors++; console.log(`⚠ #${t.id}: ${e.message}`); }
      done++;
    }
    console.log(`  … ${done} / ${rows.length}`);
  }
  console.log(`✓ Procesadas: ${done} · sin geometría visible: ${empty} · errores: ${errors}`);
  await db.close();
  process.exit(errors && errors === done ? 1 : 0);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
