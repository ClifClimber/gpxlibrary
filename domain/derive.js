'use strict';
// Derived data per route (phase 3): the geometry other people see and the text the server-side search uses.
const { privacyZones, inZones } = require('./privacy');

// Simplification tolerances in metres for tracks.geom_s1 / geom_s2 (provisional; one place to change them)
const DERIVE_TOLERANCES = { s1: 15, s2: 150 };

const latOf = p => (Array.isArray(p) ? p[0] : p.lat);
const lonOf = p => (Array.isArray(p) ? p[1] : p.lon);

/** Points visible to other people: the route without the privacy zones (same result as the on-the-fly trim). */
function visiblePoints(points, radiusM, trackId) {
  if (!points || !points.length) return [];
  const zones = privacyZones(points, radiusM, trackId);
  if (!zones.length) return points;
  return points.filter(p => !inZones(latOf(p), lonOf(p), zones));
}

const stripAccents = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Lowercase, accent-free text with name, sierra, province and tags (tags: array or JSON text). */
function searchText({ name, sierra, province, tags } = {}) {
  let t = tags;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = t ? [t] : []; } }
  if (!Array.isArray(t)) t = [];
  return stripAccents([name, sierra, province, ...t].filter(x => x != null && String(x).trim() !== '').join(' ')).toLowerCase();
}

module.exports = { DERIVE_TOLERANCES, visiblePoints, searchText };
