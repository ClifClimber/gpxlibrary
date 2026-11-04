#!/usr/bin/env node
'use strict';
// Removes the anomalous GPS points (stops drawn as a star, isolated spikes) from routes already in the database.
// Admin → Gestión de Tracks → «Puntos GPS anómalos». Originals are never touched and each route can be restored
// from its page. Routes the owner chose to ignore or that already have the cleaning applied are skipped. A route
// that was already simplified with «Limpiar tracks» keeps that simplification (its previous geometry is kept to restore).
//
//   node scripts/clean-anomalies.js --owner 3        routes of one user
//   node scripts/clean-anomalies.js --all            every route
//   node scripts/clean-anomalies.js --ids 1,2,3
//   node scripts/clean-anomalies.js --all --dry-run  report without changing anything
//   node scripts/clean-anomalies.js --all --include-dismissed
// Prints CLEANED_IDS:1,2,3 so the job can recompute the derived geometries of those routes.
const { openSql } = require('../repo/sql');
const { detectAnomalies, describeAnomalies } = require('../domain');
const { TRACK_SQL, cleanTrack } = require('./anomaly-ops');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = flag('--dry-run');

(async () => {
  const db = openSql();
  const ids = (arg('--ids') || '').split(',').map(Number).filter(Boolean);
  const owner = parseInt(arg('--owner'));
  if (!ids.length && !owner && !flag('--all')) throw new Error('Indica --owner <id>, --ids <lista> o --all');

  let sql = TRACK_SQL, where = [], params = [];
  if (ids.length) { where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (owner) { where.push('owner_id = ?'); params.push(owner); }
  const tracks = await db.all(`${sql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id`, params);
  console.log(`Revisando ${tracks.length} ruta(s)${DRY ? ' (simulación: no se cambia nada)' : ''}…\n`);

  const st = { cleaned: 0, points: 0, km: 0, ignored: 0, applied: 0, none: 0, errors: 0 };
  const done = [];
  for (const t of tracks) {
    try {
      let rec = null; try { rec = t.anomalies ? JSON.parse(t.anomalies) : null; } catch {}
      if (rec && rec.applied) { st.applied++; continue; }
      if (rec && rec.dismissed && !flag('--include-dismissed')) { st.ignored++; continue; }
      // Analysed before and nothing found: no need to read the points again
      if (rec && !rec.removable) { st.none++; continue; }
      let res;
      if (DRY) {
        const found = detectAnomalies(await db.getPoints(t.id));
        res = found.removable ? { ok: true, removed: found.removable, found, before: { distance: t.distance }, after: { distance: t.distance - (rec ? rec.savedM : 0) / 1000 } } : { ok: false, code: 409 };
      } else res = await cleanTrack(db, t);
      if (!res.ok) { st.none++; continue; }
      st.cleaned++; st.points += res.removed; st.km += Math.max(0, res.before.distance - res.after.distance);
      done.push(t.id);
      console.log(`  ✓ ${String(t.id).padStart(4)} ${String(t.name).slice(0, 40).padEnd(40)} ${describeAnomalies(res.found)} · ${res.before.distance} → ${Number(res.after.distance).toFixed(1)} km`);
    } catch (e) { st.errors++; console.log(`  ✗ ${t.id} ${t.name}: ${e.message}`); }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Rutas revisadas        : ${tracks.length}`);
  console.log(`  ${(DRY ? 'Se limpiarían' : 'Rutas limpiadas').padEnd(22)} : ${st.cleaned}`);
  console.log(`  Puntos quitados        : ${st.points}`);
  console.log(`  Distancia corregida    : ${st.km.toFixed(1)} km`);
  console.log(`  Sin anomalías          : ${st.none}`);
  console.log(`  Ignoradas por su dueño : ${st.ignored}`);
  console.log(`  Ya limpiadas           : ${st.applied}`);
  if (st.errors) console.log(`  Errores                : ${st.errors}`);
  if (done.length && !DRY) console.log(`CLEANED_IDS:${done.join(',')}`);
  await db.close();
  if (st.errors) process.exitCode = 1;
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
