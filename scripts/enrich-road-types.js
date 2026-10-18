#!/usr/bin/env node
'use strict';

// Enriquece tracks con tipos de camino y superficie desde OpenStreetMap (Overpass API).
// Uso: node scripts/enrich-road-types.js [--ids 1,2,3] [--all] [--force]

const https  = require('https');
const { openDb } = require('./db');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
let epIdx = 0;

const DELAY_MS     = 2500;   // ms between Overpass requests
const MAX_DIST_DEG = 0.0006; // ~60m matching threshold
const MAX_PTS      = 1500;   // max GPS points to sample for matching
const MAX_BBOX_DEG = 3.0;    // skip if bbox side > N degrees

// ── OSM highway → label & color ─────────────────────────────────
const HW = {
  motorway:     { label: 'Autopista',           color: '#e8803c' },
  trunk:        { label: 'Autovía',             color: '#e8803c' },
  primary:      { label: 'Carretera principal', color: '#f0c040' },
  secondary:    { label: 'Carretera secundaria',color: '#d4b040' },
  tertiary:     { label: 'Carretera local',     color: '#a0a0a0' },
  residential:  { label: 'Calle',               color: '#c0c0c0' },
  living_street:{ label: 'Calle peatonal',      color: '#d0d0d0' },
  unclassified: { label: 'Camino',              color: '#b0b0b0' },
  service:      { label: 'Vía de servicio',     color: '#c8c8c8' },
  cycleway:     { label: 'Carril bici',         color: '#4caf8c' },
  track:        { label: 'Pista forestal',      color: '#8b7355' },
  path:         { label: 'Senda',               color: '#6a8a5a' },
  footway:      { label: 'Camino peatonal',     color: '#7a9a6a' },
  bridleway:    { label: 'Camino de herradura', color: '#7a7a40' },
  steps:        { label: 'Escaleras',           color: '#909090' },
};

const SF = {
  asphalt:     { label: 'Asfalto',          color: '#404040' },
  paved:       { label: 'Pavimentado',      color: '#606060' },
  concrete:    { label: 'Hormigón',         color: '#808080' },
  cobblestone: { label: 'Adoquín',          color: '#907060' },
  sett:        { label: 'Adoquín',          color: '#907060' },
  gravel:      { label: 'Grava',            color: '#b09070' },
  fine_gravel: { label: 'Gravilla',         color: '#b8a880' },
  compacted:   { label: 'Tierra compactada',color: '#987858' },
  dirt:        { label: 'Tierra',           color: '#a07050' },
  ground:      { label: 'Tierra',           color: '#a07050' },
  unpaved:     { label: 'Sin asfaltar',     color: '#a08060' },
  grass:       { label: 'Hierba',           color: '#60a050' },
  sand:        { label: 'Arena',            color: '#d0c070' },
  wood:        { label: 'Madera',           color: '#806040' },
  metal:       { label: 'Metal',            color: '#606878' },
};

// ── Haversine ────────────────────────────────────────────────────
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371, D = Math.PI / 180;
  const dl = (lat2 - lat1) * D, dn = (lon2 - lon1) * D;
  const a = Math.sin(dl/2)**2 + Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dn/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Point-to-segment distance (degrees, 2-D approx) ─────────────
function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
  return Math.hypot(px - ax - t*dx, py - ay - t*dy);
}

// ── Overpass API request ─────────────────────────────────────────
function overpassRequest(query) {
  const body = `data=${encodeURIComponent(query)}`;
  const url  = OVERPASS_ENDPOINTS[epIdx % OVERPASS_ENDPOINTS.length];
  return new Promise((resolve, reject) => {
    const opts = {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'Content-Length': Buffer.byteLength(body),
                 'User-Agent': 'GPXLibrary/1.0 (road-type enrichment)' },
    };
    const req = https.request(url, opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0,200)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function queryOverpass(s, w, n, e) {
  const q = `[out:json][timeout:55];way["highway"](${s},${w},${n},${e});out geom;`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await overpassRequest(q);
    } catch (err) {
      if (attempt === 0) {
        epIdx++;
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }
}

// ── Nearest way matching ─────────────────────────────────────────
function nearestWay(ways, lat, lon) {
  let minDist = MAX_DIST_DEG, best = null;
  for (const way of ways) {
    const geom = way.geometry;
    if (!geom || geom.length < 2) continue;
    for (let i = 0; i < geom.length - 1; i++) {
      const d = ptSegDist(lat, lon, geom[i].lat, geom[i].lon, geom[i+1].lat, geom[i+1].lon);
      if (d < minDist) { minDist = d; best = way; }
    }
  }
  return best;
}

// ── Sleep helper ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Enrich one track ─────────────────────────────────────────────
async function enrichTrack(track, db) {
  if (!track.sw_lat) { console.log(`  ⚠ Sin bbox, saltando`); return false; }

  const latSpan = track.ne_lat - track.sw_lat;
  const lonSpan = track.ne_lon - track.sw_lon;
  if (latSpan > MAX_BBOX_DEG || lonSpan > MAX_BBOX_DEG) {
    console.log(`  ⚠ Bbox muy grande (${latSpan.toFixed(2)}°×${lonSpan.toFixed(2)}°), saltando`);
    return false;
  }

  const ptTable = track.cleaned ? 'clean_points' : 'raw_points';
  let pts = db.prepare(`SELECT lat, lon FROM ${ptTable} WHERE track_id=? ORDER BY seq`).all(track.id);
  if (pts.length < 2) { console.log(`  ⚠ Sin puntos`); return false; }

  // Sample if too many points
  if (pts.length > MAX_PTS) {
    const step = Math.ceil(pts.length / MAX_PTS);
    pts = pts.filter((_, i) => i % step === 0);
  }

  // Bbox with buffer
  const buf = 0.008;
  const s = track.sw_lat - buf, w = track.sw_lon - buf;
  const n = track.ne_lat + buf, e = track.ne_lon + buf;

  let osmData;
  try {
    osmData = await queryOverpass(s, w, n, e);
  } catch (err) {
    console.log(`  ✗ Overpass: ${err.message}`);
    return false;
  }

  const ways = (osmData.elements || []).filter(el => el.type === 'way' && el.tags?.highway);
  console.log(`  OSM: ${ways.length} caminos`);

  if (ways.length === 0) {
    // Store empty result (no OSM coverage)
    db.prepare(`UPDATE tracks SET road_types='{}', surface_types='{}', road_types_at=datetime('now') WHERE id=?`).run(track.id);
    return true;
  }

  const hwDist = {}, sfDist = {};
  for (let i = 0; i < pts.length - 1; i++) {
    const mid = { lat: (pts[i].lat + pts[i+1].lat) / 2, lon: (pts[i].lon + pts[i+1].lon) / 2 };
    const d   = hav(pts[i].lat, pts[i].lon, pts[i+1].lat, pts[i+1].lon);
    const way = nearestWay(ways, mid.lat, mid.lon);
    const hw  = way?.tags?.highway  || 'unknown';
    const sf  = way?.tags?.surface  || 'unknown';
    hwDist[hw] = (hwDist[hw] || 0) + d;
    sfDist[sf] = (sfDist[sf] || 0) + d;
  }

  // Round to 2 dp
  for (const k of Object.keys(hwDist)) hwDist[k] = Math.round(hwDist[k] * 100) / 100;
  for (const k of Object.keys(sfDist)) sfDist[k] = Math.round(sfDist[k] * 100) / 100;

  db.prepare(`UPDATE tracks SET road_types=?, surface_types=?, road_types_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(hwDist), JSON.stringify(sfDist), track.id);

  return true;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const args  = process.argv.slice(2);
  const force = args.includes('--force');
  const all   = args.includes('--all');
  const idsArg = args[args.indexOf('--ids') + 1];
  const db    = openDb();

  let tracks;
  if (idsArg) {
    const ids = idsArg.split(',').map(Number);
    tracks = db.prepare(`SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon
                         FROM tracks WHERE id IN (${ids.map(()=>'?').join(',')})`)
               .all(...ids);
  } else if (force || all) {
    tracks = db.prepare(`SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon FROM tracks ORDER BY id`).all();
  } else {
    tracks = db.prepare(`SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon
                         FROM tracks WHERE road_types IS NULL ORDER BY id`).all();
  }

  console.log(`\nEnriqueciendo ${tracks.length} tracks con datos OSM...`);
  if (!tracks.length) { console.log('Nada que hacer.\n'); return; }

  let ok = 0, fail = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    console.log(`[${i+1}/${tracks.length}] ${t.name}`);
    const success = await enrichTrack(t, db);
    if (success) ok++; else fail++;
    if (i < tracks.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n✓ Completado: ${ok} ok, ${fail} fallidos\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
