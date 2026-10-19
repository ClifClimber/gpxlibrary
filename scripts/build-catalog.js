#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const TRACKS_DIR = path.join(__dirname, '..', 'TracksGps');
const OUTPUT_FILE = path.join(__dirname, '..', 'catalog-data.js');
const MAX_POINTS = 300;

// Load optional DB metadata (activity, sierra, province, ccaa)
function loadDbMeta() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(__dirname, '..', 'tracks.db');
    if (!fs.existsSync(dbPath)) return {};
    const db = new DatabaseSync(dbPath, { readonly: true });
    const rows = db.prepare('SELECT file, activity, sierra, province, ccaa, tags FROM tracks').all();
    const map = {};
    for (const r of rows) map[r.file] = { activity: r.activity, sierra: r.sierra, province: r.province, ccaa: r.ccaa, tags: r.tags };
    db.close();
    return map;
  } catch { return {}; }
}

// ── Haversine distance in km ──────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Uniform-sample to at most maxPts points ───────────────────────────────────
function simplify(points, maxPts) {
  if (points.length <= maxPts) return points;
  const result = [];
  const step = (points.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) {
    result.push(points[Math.round(i * step)]);
  }
  return result;
}

// ── Parse a GPX file ──────────────────────────────────────────────────────────
function parseGpx(content, filePath) {
  // Unescape common XML entities
  const unescape = s => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

  // Track name – prefer <trk><name>, fall back to <metadata><name>, then filename
  let name = path.basename(filePath, '.gpx');
  const trkNameM = content.match(/<trk\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
  if (trkNameM) name = unescape(trkNameM[1]);
  else {
    const metaNameM = content.match(/<metadata\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
    if (metaNameM) name = unescape(metaNameM[1])
      .replace(/^wikiloc\s*-\s*/i, '').trim();
  }

  // Date: metadata/time > first trkpt/time > filename prefix YYYY-MM-DD
  let date = null;
  const metaTimeM = content.match(/<metadata\b[^>]*>[\s\S]*?<time>([^<]+)<\/time>/);
  if (metaTimeM) date = metaTimeM[1].trim().substring(0, 10);
  if (!date) {
    const ptTimeM = content.match(/<trkpt\b[^>]*>[\s\S]*?<time>([^<]+)<\/time>/);
    if (ptTimeM) date = ptTimeM[1].trim().substring(0, 10);
  }
  if (!date) {
    const fnDateM = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
    if (fnDateM) date = fnDateM[1];
  }

  // Track points – iterate with indexOf for reliability
  const points = [];
  let pos = 0;
  while (true) {
    const tStart = content.indexOf('<trkpt', pos);
    if (tStart === -1) break;
    const tagEnd = content.indexOf('>', tStart);
    if (tagEnd === -1) break;
    const closePos = content.indexOf('</trkpt>', tagEnd);
    const tagStr = content.substring(tStart, tagEnd + 1);
    const body = closePos !== -1 ? content.substring(tagEnd + 1, closePos) : '';

    const latM = tagStr.match(/\blat="([^"]+)"/);
    const lonM = tagStr.match(/\blon="([^"]+)"/);
    const eleM = body.match(/<ele>([^<]+)<\/ele>/);

    if (latM && lonM) {
      const lat = parseFloat(latM[1]);
      const lon = parseFloat(lonM[1]);
      if (!isNaN(lat) && !isNaN(lon)) {
        points.push({ lat, lon, ele: eleM ? parseFloat(eleM[1]) : null });
      }
    }
    pos = closePos !== -1 ? closePos + 8 : tagEnd + 1;
  }

  if (points.length < 2) return null;

  // Distance (km)
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }

  // Elevation
  let elevationGain = 0, elevationLoss = 0;
  let minEle = Infinity, maxEle = -Infinity;
  let hasEle = false;
  for (let i = 0; i < points.length; i++) {
    const e = points[i].ele;
    if (e !== null && !isNaN(e)) {
      hasEle = true;
      if (e < minEle) minEle = e;
      if (e > maxEle) maxEle = e;
      if (i > 0 && points[i - 1].ele !== null && !isNaN(points[i - 1].ele)) {
        const diff = e - points[i - 1].ele;
        if (diff > 0) elevationGain += diff;
        else elevationLoss -= diff;
      }
    }
  }

  // Bounds
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const simplified = simplify(points, MAX_POINTS).map(p => [
    Math.round(p.lat * 100000) / 100000,
    Math.round(p.lon * 100000) / 100000,
    p.ele !== null && !isNaN(p.ele) ? Math.round(p.ele) : null
  ]);

  const rel = path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/');
  const parts = path.relative(TRACKS_DIR, filePath).split(path.sep);
  const zone = parts.length > 2 ? parts[1] : null;

  return {
    name,
    file: rel,
    zone,
    date,
    distance: Math.round(distance * 10) / 10,
    elevationGain: Math.round(elevationGain),
    elevationLoss: Math.round(elevationLoss),
    minElevation: hasEle ? Math.round(minEle) : null,
    maxElevation: hasEle ? Math.round(maxEle) : null,
    bounds: [[minLat, minLon], [maxLat, maxLon]],
    center: [
      Math.round(((minLat + maxLat) / 2) * 10000) / 10000,
      Math.round(((minLon + maxLon) / 2) * 10000) / 10000
    ],
    points: simplified
  };
}

// ── Recurse directory ──────────────────────────────────────────────────────────
function collectGpx(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectGpx(full));
    else if (entry.name.toLowerCase().endsWith('.gpx')) results.push(full);
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const files = collectGpx(TRACKS_DIR);
console.log(`Encontrados ${files.length} archivos GPX...`);

const dbMeta = loadDbMeta();
const dbMetaCount = Object.keys(dbMeta).length;
if (dbMetaCount) console.log(`Metadata DB: ${dbMetaCount} tracks`);

const catalog = [];
let errors = 0;

for (const filePath of files) {
  try {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      content = fs.readFileSync(filePath, 'latin1');
    }
    const track = parseGpx(content, filePath);
    if (track) {
      const meta = dbMeta[track.file] || {};
      track.activity = meta.activity || null;
      track.sierra   = meta.sierra   || null;
      track.province = meta.province || null;
      track.ccaa     = meta.ccaa     || null;
      track.tags     = meta.tags ? JSON.parse(meta.tags) : [];
      catalog.push(track);
    } else { console.warn(`  ⚠ Sin puntos: ${path.basename(filePath)}`); errors++; }
  } catch (e) {
    console.error(`  ✗ Error en ${path.basename(filePath)}: ${e.message}`);
    errors++;
  }
}

// Sort by date descending, undated last
catalog.sort((a, b) => {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return a.name.localeCompare(b.name);
});

const js = `// Auto-generado por scripts/build-catalog.js\n// ${catalog.length} tracks · ${new Date().toISOString()}\nconst CATALOG = ${JSON.stringify(catalog)};\n`;
fs.writeFileSync(OUTPUT_FILE, js, 'utf8');

const sizeKb = Math.round(Buffer.byteLength(js) / 1024);
console.log(`\n✓ catalog-data.js generado: ${catalog.length} tracks, ${sizeKb} KB (${errors} errores)`);

const acts = {};
for (const t of catalog) acts[t.activity||'Sin actividad'] = (acts[t.activity||'Sin actividad'] || 0) + 1;
console.log('\nActividades:');
for (const [act, n] of Object.entries(acts).sort((a, b) => b[1] - a[1]))
  console.log(`  ${act.padEnd(30)} ${n} tracks`);
