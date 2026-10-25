'use strict';
const { havKm } = require('./geo');

// Elevation changes below this many metres are treated as GPS noise.
const ELE_NOISE_M = 8;
// Start and end closer than this (km) make the route circular.
const CIRCULAR_KM = 0.5;

/** Distance, elevation, bounds and circularity of a point list ({lat, lon, ele}). */
function computeMetrics(points) {
  if (!points || points.length < 2) return null;
  let dist = 0;
  for (let i = 1; i < points.length; i++) dist += havKm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);

  const first = points[0], last = points[points.length - 1];
  const circular = havKm(first.lat, first.lon, last.lat, last.lon) < CIRCULAR_KM ? 1 : 0;

  let gain = 0, loss = 0, minEle = Infinity, maxEle = -Infinity, hasEle = false, lastAccEle = null;
  for (const p of points) {
    const e = p.ele;
    if (e == null || isNaN(e)) continue;
    hasEle = true;
    if (e < minEle) minEle = e;
    if (e > maxEle) maxEle = e;
    if (lastAccEle == null) { lastAccEle = e; continue; }
    const d = e - lastAccEle;
    if (Math.abs(d) >= ELE_NOISE_M) { if (d > 0) gain += d; else loss -= d; lastAccEle = e; }
  }

  let swLat = Infinity, swLon = Infinity, neLat = -Infinity, neLon = -Infinity;
  for (const p of points) {
    if (p.lat < swLat) swLat = p.lat;
    if (p.lat > neLat) neLat = p.lat;
    if (p.lon < swLon) swLon = p.lon;
    if (p.lon > neLon) neLon = p.lon;
  }

  return {
    distance: Math.round(dist * 10) / 10,
    elevationGain: Math.round(gain),
    elevationLoss: Math.round(loss),
    minElevation: hasEle ? Math.round(minEle) : null,
    maxElevation: hasEle ? Math.round(maxEle) : null,
    swLat, swLon, neLat, neLon,
    centerLat: Math.round((swLat + neLat) / 2 * 10000) / 10000,
    centerLon: Math.round((swLon + neLon) / 2 * 10000) / 10000,
    circular,
  };
}

// Below this speed (km/h) a segment counts as stopped; gaps over MAX_GAP_S are ignored (pauses/signal loss).
const MOVING_KMH = 0.8;
const MAX_GAP_S = 300;

/** Moving and stopped seconds from timestamped points; null if the track has no usable times. */
function computeTimes(points) {
  const pts = (points || []).filter(p => p.time != null);
  if (pts.length < 2) return null;
  let moving = 0, stopped = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].time - pts[i - 1].time) / 1000;
    if (dt <= 0 || dt > MAX_GAP_S) continue;
    const speed = havKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) / dt * 3600;
    if (speed > MOVING_KMH) moving += dt; else stopped += dt;
  }
  return moving + stopped > 0 ? { moving: Math.round(moving), stopped: Math.round(stopped) } : null;
}

module.exports = { computeMetrics, computeTimes, ELE_NOISE_M, CIRCULAR_KM };
