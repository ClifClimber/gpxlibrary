'use strict';
// Privacy zones: other people never see the points of a route near its start and its end
// (usually the owner's home). Each zone is a circle around the real start/end, moved and enlarged
// by an amount derived from a seed (the track id) so the hidden point isn't simply its centre.
const { havM } = require('./geo');

const latOf = p => (Array.isArray(p) ? p[0] : p.lat);
const lonOf = p => (Array.isArray(p) ? p[1] : p.lon);

// Deterministic pseudo-random in [0, 1) from an integer seed and a salt
function rand(seed, salt) {
  let h = (Number(seed) || 0) * 2654435761 + salt * 40503;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Zones [{lat, lon, r}] around the first and last point; [] when radiusM ≤ 0 or no points. */
function privacyZones(points, radiusM, seed = 0) {
  const r0 = Number(radiusM) || 0;
  if (r0 <= 0 || !points || !points.length) return [];
  const ends = [points[0], points[points.length - 1]];
  return ends.map((p, i) => {
    const ang = rand(seed, 1 + i * 3) * 2 * Math.PI;
    const off = rand(seed, 2 + i * 3) * 0.4 * r0;        // centre moved up to 40 % of the radius
    const r = r0 * (1.2 + rand(seed, 3 + i * 3) * 0.3);  // and the circle made 20–50 % bigger, so the real point stays inside
    const lat = latOf(p) + (off * Math.cos(ang)) / 111320;
    const lon = lonOf(p) + (off * Math.sin(ang)) / (111320 * Math.cos(latOf(p) * Math.PI / 180));
    return { lat, lon, r };
  });
}

const inZones = (lat, lon, zones) => zones.some(z => havM(lat, lon, z.lat, z.lon) <= z.r);

/** Points (arrays [lat, lon, …] or {lat, lon}) without those inside the privacy zones. */
function privacyTrim(points, radiusM, seed = 0) {
  const zones = privacyZones(points, radiusM, seed);
  if (!zones.length) return points;
  return points.filter(p => !inZones(latOf(p), lonOf(p), zones));
}

module.exports = { privacyZones, privacyTrim, inZones };
