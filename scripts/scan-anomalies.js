#!/usr/bin/env node
'use strict';
// Looks for anomalous GPS points (stops drawn as a star, isolated spikes) in routes already in the database and stores
// the result in tracks.anomalies. It only reports: nothing is removed (that is done from the route's page).
//
//   node scripts/scan-anomalies.js --missing          routes never analysed (default)
//   node scripts/scan-anomalies.js --all              every route again (e.g. after changing the thresholds)
//   node scripts/scan-anomalies.js --ids 1,2,3
//   node scripts/scan-anomalies.js --owner 3          routes of one user (add --all to re-analyse them)
//   node scripts/scan-anomalies.js --all --dry-run    report without storing
const { openSql } = require('../repo/sql');
const { detectAnomalies, describeAnomalies, anomalyRecord } = require('../domain');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = flag('--dry-run');

(async () => {
  const db = openSql();
  const ids = (arg('--ids') || '').split(',').map(Number).filter(Boolean);
  let sql = 'SELECT id, name, cleaned, anomalies FROM tracks';
  const params = [];
  if (ids.length) { sql += ` WHERE id IN (${ids.map(() => '?').join(',')})`; params.push(...ids); }
  const owner = parseInt(arg('--owner'));
  if (owner) { sql += `${ids.length ? ' AND' : ' WHERE'} owner_id = ?`; params.push(owner); }
  if (!ids.length && !flag('--all')) sql += `${owner ? ' AND' : ' WHERE'} anomalies IS NULL`;
  sql += ' ORDER BY id';
  const tracks = await db.all(sql, params);
  console.log(`Analizando ${tracks.length} ruta(s)${DRY ? ' (simulación: no se guarda nada)' : ''}…\n`);

  let withAnomalies = 0, clusters = 0, spikes = 0, points = 0, km = 0, done = 0;
  for (const t of tracks) {
    const pts = await db.getPoints(t.id);                // the original points, as imported
    const r = detectAnomalies(pts);
    const rec = anomalyRecord(pts, r);
    // Keep what the user decided about this route: "ignorar" and an applied cleaning survive a new analysis
    let old = null; try { old = t.anomalies ? JSON.parse(t.anomalies) : null; } catch {}
    // «Ignorar» holds only for what was found back then: if the analysis now finds more, warn again
    if (old) { if (old.dismissed && rec.removable <= old.removable) rec.dismissed = true; if (old.applied) rec.applied = old.applied; }
    if (r.removable) {
      withAnomalies++; clusters += r.clusters.length; spikes += r.spikes.length; points += r.removable; km += rec.savedM / 1000;
      console.log(`  ⚠ ${String(t.id).padStart(4)} ${t.name.slice(0, 44).padEnd(44)} ${describeAnomalies(r)} · ${r.removable} pts · ${(rec.savedM / 1000).toFixed(2)} km`);
    }
    if (!DRY) await db.run('UPDATE tracks SET anomalies=? WHERE id=?', [JSON.stringify(rec), t.id]);
    if (++done % 100 === 0) console.log(`  … ${done} / ${tracks.length}`);
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Rutas analizadas    : ${tracks.length}`);
  console.log(`  Con anomalías       : ${withAnomalies}`);
  console.log(`  Paradas con ruido   : ${clusters}`);
  console.log(`  Saltos aislados     : ${spikes}`);
  console.log(`  Puntos a quitar     : ${points}`);
  console.log(`  Distancia inflada   : ${km.toFixed(1)} km`);
  await db.close();
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
