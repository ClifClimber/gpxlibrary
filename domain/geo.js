'use strict';
// Pure geometry helpers shared by import, metrics, cleaning and export.

const D = Math.PI / 180;

function havKm(lat1, lon1, lat2, lon2) {
  const dl = (lat2 - lat1) * D, dn = (lon2 - lon1) * D;
  const a = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dn / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const havM = (lat1, lon1, lat2, lon2) => havKm(lat1, lon1, lat2, lon2) * 1000;

// Distance in metres from p to segment a–b, on a local equirectangular projection.
function perpDistM(p, a, b) {
  const midLat = (a.lat + b.lat) / 2, mLat = 111132, mLon = 111132 * Math.cos(midLat * D);
  const bx = (b.lon - a.lon) * mLon, by = (b.lat - a.lat) * mLat;
  const px = (p.lon - a.lon) * mLon, py = (p.lat - a.lat) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

module.exports = { havKm, havM, perpDistM };
