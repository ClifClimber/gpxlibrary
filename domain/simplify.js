'use strict';
// Point reduction: even sampling for display, and the GPS cleaning filters.
const { havM, perpDistM } = require('./geo');

/** Keeps maxN points spread evenly along the list (first and last included). */
function sampleEvenly(pts, maxN) {
  if (!pts || pts.length <= maxN) return pts;
  const out = [], step = (pts.length - 1) / (maxN - 1);
  for (let i = 0; i < maxN; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

/** Drops isolated GPS spikes: points far from both neighbours that the neighbours would skip. */
function filterMaxJump(pts, maxM) {
  if (!maxM || pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1], next = pts[i + 1];
    const dPC = havM(prev.lat, prev.lon, pts[i].lat, pts[i].lon);
    const dCN = havM(pts[i].lat, pts[i].lon, next.lat, next.lon);
    const dPN = havM(prev.lat, prev.lon, next.lat, next.lon);
    if (!(dPC > maxM && dCN > maxM && dPN < (dPC + dCN) * 0.55)) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Drops points closer than minM to the previous kept one (stationary noise). */
function filterMinDist(pts, minM) {
  if (!minM || pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    if (havM(prev.lat, prev.lon, pts[i].lat, pts[i].lon) >= minM) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Iterative Ramer–Douglas–Peucker with a tolerance in metres. */
function rdpSimplify(pts, eps) {
  if (!eps || pts.length <= 2) return pts;
  const n = pts.length, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j - i < 2) continue;
    let maxD = 0, maxK = i + 1;
    for (let k = i + 1; k < j; k++) { const d = perpDistM(pts[k], pts[i], pts[j]); if (d > maxD) { maxD = d; maxK = k; } }
    if (maxD > eps) { keep[maxK] = 1; stack.push([i, maxK], [maxK, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Applies the enabled filters in order: spikes, minimum distance, RDP. */
function cleanPoints(pts, { maxJump = 0, minDist = 0, rdp = 0 } = {}) {
  let out = pts;
  if (maxJump > 0) out = filterMaxJump(out, maxJump);
  if (minDist > 0) out = filterMinDist(out, minDist);
  if (rdp > 0) out = rdpSimplify(out, rdp);
  return out;
}

module.exports = { sampleEvenly, filterMaxJump, filterMinDist, rdpSimplify, cleanPoints };
