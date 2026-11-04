'use strict';
// Removing / restoring anomalous GPS points of one route. Shared by the route page (POST /api/tracks/:id/anomalies)
// and the admin job (scripts/clean-anomalies.js), so both do exactly the same thing.
// The original GPX is never touched: «clean» writes the clean geometry (the one the detail page and the visor use)
// and recomputes distance and elevation from it; «restore» undoes both.
const { detectAnomalies, removeAnomalies, anomalyRecord, computeMetrics, cleanPoints } = require('../domain');

// A route can already have a clean geometry from Admin → «Limpiar tracks» (min-dist + RDP). Removing the anomalies then
// rebuilds that geometry from the star-free points with these same defaults, and keeps the previous one to restore it.
const RESIMPLIFY = { minDist: 5, rdp: 8 };
const MAX_PREV_POINTS = 30000;

const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const metricsSet = (t, m) => (m ? [m.distance, m.elevationGain, m.elevationLoss] : [t.distance, t.elevation_gain, t.elevation_loss]);

/** Columns a route needs for these operations. */
const TRACK_SQL = 'SELECT id, name, cleaned, distance, elevation_gain, elevation_loss, anomalies FROM tracks';

/**
 * Removes the anomalous points of a route.
 * @param db   openSql() instance
 * @param t    row from TRACK_SQL
 * @returns {{ok:true, removed, before, after, found}|{ok:false, code, error}}
 */
async function cleanTrack(db, t) {
  const rec = parse(t.anomalies);
  if (rec && rec.applied) return { ok: false, code: 409, error: 'Los puntos anómalos ya están quitados' };
  const raw = await db.getPoints(t.id);
  const found = detectAnomalies(raw);
  if (!found.removable) return { ok: false, code: 409, error: 'No se han encontrado puntos anómalos' };
  const free = removeAnomalies(raw, found);                     // star-free points: distance and elevation come from these
  const prev = t.cleaned ? await db.getPoints(t.id, { clean: true }) : null;
  const clean = prev ? cleanPoints(free, RESIMPLIFY) : free;
  const before = { distance: t.distance, elevation_gain: t.elevation_gain, elevation_loss: t.elevation_loss };
  const m = computeMetrics(free);
  const applied = { at: new Date().toISOString(), removed: found.removable, before };
  if (prev && prev.length && prev.length <= MAX_PREV_POINTS) applied.prev = prev.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6), p.ele == null ? null : +Number(p.ele).toFixed(1)]);
  else if (prev) applied.prevLost = true;
  const next = { ...anomalyRecord(raw, found), ...(rec && rec.dismissed ? { dismissed: true } : {}), applied };
  await db.tx(async tx => {
    await tx.setPoints(t.id, clean, { clean: true });
    await tx.run(`UPDATE tracks SET cleaned = 1, clean_count = ?, cleaned_at = ${tx.NOW}, distance = ?, elevation_gain = ?, elevation_loss = ?, anomalies = ? WHERE id = ?`,
      [clean.length, ...metricsSet(t, m), JSON.stringify(next), t.id]);
  });
  return { ok: true, removed: found.removable, before, found,
    after: m ? { distance: m.distance, elevation_gain: m.elevationGain, elevation_loss: m.elevationLoss } : before };
}

/** Brings the original points back. */
async function restoreTrack(db, t) {
  const rec = parse(t.anomalies);
  if (!(rec && rec.applied)) return { ok: false, code: 409, error: 'No hay una limpieza de puntos anómalos que restaurar' };
  const raw = await db.getPoints(t.id);
  const m = computeMetrics(raw);
  const { applied, ...rest } = rec;
  // The route had another cleaning before: put that geometry back (or rebuild it with the defaults if it was too big to keep)
  const hadClean = !!(applied.prev || applied.prevLost);
  const back = applied.prev ? applied.prev.map(([lat, lon, ele]) => ({ lat, lon, ele })) : hadClean ? cleanPoints(raw, RESIMPLIFY) : [];
  await db.tx(async tx => {
    await tx.setPoints(t.id, back, { clean: true });
    await tx.run(`UPDATE tracks SET cleaned = ?, clean_count = ?, cleaned_at = ${hadClean ? tx.NOW : 'NULL'}, distance = ?, elevation_gain = ?, elevation_loss = ?, anomalies = ? WHERE id = ?`,
      [hadClean ? 1 : 0, hadClean ? back.length : null, ...metricsSet(t, m), JSON.stringify(rest), t.id]);
  });
  return { ok: true };
}

module.exports = { TRACK_SQL, cleanTrack, restoreTrack };
