'use strict';
// Anomalous GPS points: what a bad fix leaves in a track. Pure and geometric (no database, no times needed), so the
// same answer comes out at import, from the stored points and from the track page.
//
//   cluster — a stop with GPS drift: many points inside a small circle whose path zigzags around instead of going
//             anywhere (the "star" you see on the map when you stop). Slow, smooth wandering is not flagged. Interior points go; first and last stay, so the
//             route still enters and leaves the stop and the timing of the track doesn't change.
//   spike   — one isolated point far from where the track was and where it goes next (the line jumps out and back).
const { havM } = require('./geo');

const DEFAULTS = {
  clusterRadiusM: 20,     // points within this distance of the stop's centre
  clusterMinPoints: 8,    // fewer points than this is not a stop with drift
  clusterMinRadiusM: 3,   // typical drift (80 % of the points) smaller than this does not show on the map
  clusterMinPathM: 30,    // the scribble must be at least this long to show on the map
  clusterMinRatio: 3,     // path length ÷ diameter: ≈1 walking straight, several times that when it wanders about
  clusterMinReversal: 0.35, // share of moves that turn back more than 90°: ≈0.5 for random drift, low when just wandering
  spikeMinM: 100,         // each leg of the spike at least this long…
  spikeSpacingMult: 6,    // …and at least this many times the typical distance between points
  spikeReturnRatio: 0.35, // the neighbours are close to each other (distance ÷ shorter leg)
  denseMedianM: 40,       // spikes are only looked for in dense recordings (median step below this)
};

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = n => Math.round(n * 10) / 10;

// Metres per degree at this latitude, to measure distances to a centre cheaply
function metres(lat) { return { y: 111132, x: 111132 * Math.cos(lat * Math.PI / 180) }; }

// Share of the moves in pts[from..to) that turn back (angle over 90°) from the previous move: the mark of random drift
function reversalShare(pts, from, to) {
  let turns = 0, back = 0;
  for (let k = from + 2; k < to; k++) {
    const co = Math.cos(pts[k].lat * Math.PI / 180);
    const ax = (pts[k - 1].lon - pts[k - 2].lon) * co, ay = pts[k - 1].lat - pts[k - 2].lat;
    const bx = (pts[k].lon - pts[k - 1].lon) * co, by = pts[k].lat - pts[k - 1].lat;
    if (!(ax || ay) || !(bx || by)) continue;           // repeated point: no direction
    turns++;
    if (ax * bx + ay * by < 0) back++;
  }
  return turns ? back / turns : 0;
}

// Centre, spread, path and drift of pts[from..to] (both included)
function clusterStats(pts, from, to) {
  const count = to - from + 1;
  let sLat = 0, sLon = 0;
  for (let k = from; k <= to; k++) { sLat += pts[k].lat; sLon += pts[k].lon; }
  const cLat = sLat / count, cLon = sLon / count;
  let rho = 0, path = 0;
  const dist = [];
  for (let k = from; k <= to; k++) {
    const d = havM(cLat, cLon, pts[k].lat, pts[k].lon);
    dist.push(d);
    rho = Math.max(rho, d);
    if (k > from) path += havM(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);
  }
  // Typical spread: the few points of a straight approach or exit inside the circle don't inflate it
  const rhoTypical = dist.sort((x, y) => x - y)[Math.floor(0.8 * (count - 1))];
  const t0 = pts[from].time, t1 = pts[to].time;
  return { from, to, count, lat: Math.round(cLat * 1e6) / 1e6, lon: Math.round(cLon * 1e6) / 1e6, rho, rhoTypical, path,
    ratio: path / Math.max(2 * rho, 1), reversal: reversalShare(pts, from, to + 1),
    seconds: t0 != null && t1 != null ? Math.round((t1 - t0) / 1000) : null };
}

const isStar = (c, o, maxRho) => c.count >= o.clusterMinPoints && c.rhoTypical >= o.clusterMinRadiusM && c.rho <= maxRho &&
  c.path >= o.clusterMinPathM && c.ratio >= o.clusterMinRatio && c.reversal >= o.clusterMinReversal;

function findClusters(pts, o) {
  const found = [];
  const n = pts.length;
  let i = 0;
  while (i < n - o.clusterMinPoints + 1) {
    // Longest run from i that stays inside the radius around its first point
    let j = i + 1;
    while (j < n && havM(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon) <= o.clusterRadiusM) j++;
    if (j - i >= o.clusterMinPoints) {
      const c = clusterStats(pts, i, j - 1);
      if (isStar(c, o, o.clusterRadiusM)) { found.push(c); i = j; continue; }
    }
    i++;
  }
  // One stop can come out as several runs (the first point of a run may sit at the edge of the drift): join
  // those that touch and share a centre, so it is reported, and counted, once
  const merged = [];
  for (const c of found) {
    const last = merged[merged.length - 1];
    if (last && c.from - last.to <= 3 && havM(last.lat, last.lon, c.lat, c.lon) <= o.clusterRadiusM) {
      const m = clusterStats(pts, last.from, c.to);
      if (isStar(m, o, o.clusterRadiusM * 1.5)) { merged[merged.length - 1] = m; continue; }
    }
    merged.push(c);
  }
  return merged.map(c => ({ from: c.from, to: c.to, count: c.count, lat: c.lat, lon: c.lon, radiusM: r1(c.rhoTypical),
    pathM: Math.round(c.path), reversal: Math.round(c.reversal * 100) / 100, seconds: c.seconds }));
}

function findSpikes(pts, o, skip) {
  const n = pts.length;
  if (n < 5) return [];
  const steps = [];
  for (let i = 1; i < n; i++) steps.push(havM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  const med = median(steps);
  if (med > o.denseMedianM) return [];                       // a drawn or sparse route: a hairpin is not a GPS error
  const minLeg = Math.max(o.spikeMinM, o.spikeSpacingMult * med);
  const out = [];
  let prev = 0;
  for (let i = 1; i < n - 1; i++) {
    if (skip.has(i)) continue;
    const next = i + 1;
    const dPC = havM(pts[prev].lat, pts[prev].lon, pts[i].lat, pts[i].lon);
    const dCN = havM(pts[i].lat, pts[i].lon, pts[next].lat, pts[next].lon);
    const dPN = havM(pts[prev].lat, pts[prev].lon, pts[next].lat, pts[next].lon);
    if (dPC >= minLeg && dCN >= minLeg && dPN <= o.spikeReturnRatio * Math.min(dPC, dCN)) {
      out.push({ index: i, lat: pts[i].lat, lon: pts[i].lon, jumpM: Math.round(Math.min(dPC, dCN)) });
      continue;                                              // the next point is compared with the same `prev`
    }
    prev = i;
  }
  return out;
}

/**
 * @param {{lat:number, lon:number, time?:number|null}[]} points  in track order
 * @returns {{total, removable, clusters:object[], spikes:object[]}}  `removable` = points that removeAnomalies drops
 */
function detectAnomalies(points, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pts = points || [];
  const clusters = pts.length >= o.clusterMinPoints ? findClusters(pts, o) : [];
  const inCluster = new Set();
  for (const c of clusters) for (let k = c.from + 1; k < c.to; k++) inCluster.add(k);
  const spikes = findSpikes(pts, o, inCluster);
  return { total: pts.length, removable: inCluster.size + spikes.length, clusters, spikes };
}

/** The points without the anomalies: stops keep their first and last point, spikes are dropped. */
function removeAnomalies(points, result) {
  const drop = new Set();
  for (const c of result.clusters) for (let k = c.from + 1; k < c.to; k++) drop.add(k);
  for (const s of result.spikes) drop.add(s.index);
  return points.filter((_, i) => !drop.has(i));
}

/** One-line description for logs and messages, e.g. «2 paradas con ruido GPS (47 puntos) · 1 salto». */
function describeAnomalies(r) {
  const parts = [];
  const cp = r.clusters.reduce((s, c) => s + Math.max(0, c.count - 2), 0);
  if (r.clusters.length) parts.push(`${r.clusters.length} parada${r.clusters.length === 1 ? '' : 's'} con ruido GPS (${cp} punto${cp === 1 ? '' : 's'})`);
  if (r.spikes.length) parts.push(`${r.spikes.length} salto${r.spikes.length === 1 ? '' : 's'} aislado${r.spikes.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Distance of a point list in metres. */
function pathM(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += havM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  return d;
}

/**
 * What is stored in tracks.anomalies: the detection plus how much distance the star shapes add (savedM), so the
 * warning can say what cleaning would change. Always stored, also when nothing was found (= analysed).
 */
function anomalyRecord(points, result, at = new Date()) {
  const savedM = result.removable ? Math.max(0, Math.round(pathM(points) - pathM(removeAnomalies(points, result)))) : 0;
  return { v: 1, at: at.toISOString(), total: result.total, removable: result.removable, savedM,
    clusters: result.clusters, spikes: result.spikes };
}

module.exports = { ANOMALY_DEFAULTS: DEFAULTS, detectAnomalies, removeAnomalies, describeAnomalies, anomalyRecord };
