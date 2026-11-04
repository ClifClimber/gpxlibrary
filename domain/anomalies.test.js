'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectAnomalies, removeAnomalies, describeAnomalies } = require('./anomalies');
const { havM } = require('./geo');

// Deterministic pseudo-random numbers so the "drift" is the same on every run
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const M = 111132;   // metres per degree of latitude
const pt = (lat, lon, time = null) => ({ lat, lon, ele: 1000, time });

/** A track going north at `step` metres per point, with `stop` at point `at`: random GPS drift of ±`wander` m. */
function track({ before = 60, after = 60, step = 3, stopPts = 0, wander = 8, seed = 1 } = {}) {
  const rand = rng(seed), pts = [];
  let lat = 40;
  for (let i = 0; i < before; i++, lat += step / M) pts.push(pt(lat, -3.7, i * 1000));
  const cLat = lat, cLon = -3.7;
  for (let i = 0; i < stopPts; i++) pts.push(pt(cLat + (rand() - 0.5) * 2 * wander / M, cLon + (rand() - 0.5) * 2 * wander / M / 0.77, (before + i) * 1000));
  for (let i = 0; i < after; i++, lat += step / M) pts.push(pt(lat + 0, -3.7, (before + stopPts + i) * 1000));
  return pts;
}

test('a stop with GPS drift is a cluster; the points of the stop go but its first and last stay', () => {
  const pts = track({ stopPts: 80, wander: 8 });
  const r = detectAnomalies(pts);
  assert.equal(r.clusters.length, 1);
  assert.ok(r.clusters[0].count >= 70, `count ${r.clusters[0].count}`);
  assert.ok(r.clusters[0].reversal >= 0.35);
  assert.equal(r.spikes.length, 0);
  const clean = removeAnomalies(pts, r);
  assert.equal(clean.length, pts.length - r.removable);
  assert.ok(clean.length < 130);
  assert.equal(clean[0], pts[0]);
  assert.equal(clean[clean.length - 1], pts[pts.length - 1]);
});

test('cleaning the star shortens the distance it had inflated', () => {
  const pts = track({ stopPts: 120, wander: 10 });
  const len = a => a.slice(1).reduce((s, p, i) => s + havM(a[i].lat, a[i].lon, p.lat, p.lon), 0);
  const clean = removeAnomalies(pts, detectAnomalies(pts));
  assert.ok(len(pts) - len(clean) > 200, `only ${Math.round(len(pts) - len(clean))} m less`);
});

test('a clean route has no anomalies', () => {
  const r = detectAnomalies(track({ stopPts: 0 }));
  assert.deepEqual([r.clusters.length, r.spikes.length, r.removable], [0, 0, 0]);
});

test('walking slowly in a straight line is not a stop with drift', () => {
  const pts = Array.from({ length: 200 }, (_, i) => pt(40 + i * 0.4 / M, -3.7));
  assert.equal(detectAnomalies(pts).removable, 0);
});

test('a stop with tiny jitter (invisible on the map) is not flagged', () => {
  const r = detectAnomalies(track({ stopPts: 100, wander: 0.4 }));
  assert.equal(r.clusters.length, 0);
});

test('smooth, slow wandering around a hut (few direction reversals) is not flagged', () => {
  // an expanding spiral: always turning the same way, never doubling back
  const pts = [];
  for (let i = 0; i < 200; i++) { const a = i * 0.12, r = 3 + i * 0.05; pts.push(pt(40 + r * Math.sin(a) / M, -3.7 + r * Math.cos(a) / M / 0.77)); }
  assert.equal(detectAnomalies(pts).clusters.length, 0);
});

test('an isolated GPS spike in a dense recording is detected and dropped', () => {
  const pts = track({ stopPts: 0 });
  const spike = pt(pts[40].lat + 400 / M, pts[40].lon);
  const withSpike = [...pts.slice(0, 40), spike, ...pts.slice(40)];
  const r = detectAnomalies(withSpike);
  assert.equal(r.spikes.length, 1);
  assert.equal(r.spikes[0].index, 40);
  assert.ok(r.spikes[0].jumpM >= 390);
  assert.equal(removeAnomalies(withSpike, r).length, pts.length);
});

test('an out-and-back in a sparse (drawn) route is not a spike', () => {
  // vertices every ~250 m: to the summit and back along the same line
  const pts = [pt(40, -3.7), pt(40 + 250 / M, -3.7), pt(40 + 500 / M, -3.7), pt(40 + 250 / M, -3.7), pt(40, -3.7), pt(40 - 250 / M, -3.7)];
  assert.equal(detectAnomalies(pts).spikes.length, 0);
});

test('a spike inside a stop is not counted twice', () => {
  const pts = track({ stopPts: 80, wander: 8 });
  const r = detectAnomalies(pts);
  assert.equal(r.removable, r.clusters.reduce((s, c) => s + Math.max(0, c.count - 2), 0) + r.spikes.length);
});

test('time is only reported when the points have it', () => {
  assert.equal(detectAnomalies(track({ stopPts: 80 })).clusters[0].seconds > 0, true);
  const noTime = track({ stopPts: 80 }).map(p => ({ ...p, time: null }));
  assert.equal(detectAnomalies(noTime).clusters[0].seconds, null);
});

test('describeAnomalies reads naturally', () => {
  const text = describeAnomalies({ clusters: [{ count: 12 }, { count: 22 }], spikes: [{}] });
  assert.equal(text, '2 paradas con ruido GPS (30 puntos) · 1 salto aislado');
  assert.equal(describeAnomalies({ clusters: [], spikes: [] }), '');
});

test('empty and tiny tracks do not break it', () => {
  assert.equal(detectAnomalies([]).removable, 0);
  assert.equal(detectAnomalies([pt(40, -3)]).removable, 0);
  assert.equal(detectAnomalies(null).total, 0);
});
