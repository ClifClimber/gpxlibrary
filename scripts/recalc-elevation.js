#!/usr/bin/env node
'use strict';
// Recalcula elevation_gain/loss para todos los tracks usando raw_points con umbral de 5m
const { openDb } = require('./db');

const THRESHOLD = 8; // metros

const db = openDb();
const tracks = db.prepare('SELECT id, name FROM tracks ORDER BY id').all();
console.log(`Recalculando ${tracks.length} tracks (umbral ${THRESHOLD}m)...`);

const getPoints = db.prepare('SELECT ele FROM raw_points WHERE track_id=? ORDER BY seq');
const update    = db.prepare('UPDATE tracks SET elevation_gain=?, elevation_loss=? WHERE id=?');

let updated = 0, skipped = 0;
for (const t of tracks) {
  const pts = getPoints.all(t.id).map(r => r.ele);
  const hasEle = pts.some(e => e != null);
  if (!hasEle) { skipped++; continue; }

  let gain = 0, loss = 0, lastAcc = null;
  for (const e of pts) {
    if (e == null || isNaN(e)) continue;
    if (lastAcc != null) {
      const d = e - lastAcc;
      if (Math.abs(d) >= THRESHOLD) {
        if (d > 0) gain += d; else loss -= d;
        lastAcc = e;
      }
    } else { lastAcc = e; }
  }
  update.run(Math.round(gain), Math.round(loss), t.id);
  updated++;
}

console.log(`✓ ${updated} tracks actualizados, ${skipped} sin altitud`);
db.close();
