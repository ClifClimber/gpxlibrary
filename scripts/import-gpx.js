#!/usr/bin/env node
'use strict';

// Importa todos los GPX de TracksGps/ a la base de datos SQLite.
// Almacena los puntos originales completos (sin simplificar).
// Uso: node scripts/import-gpx.js [--force]
//   --force   reimportar tracks ya existentes

const fs   = require('fs');
const path = require('path');
const { openDb, withTransaction } = require('./db');

const TRACKS_DIR = path.join(__dirname, '..', 'TracksGps');
const FORCE = process.argv.includes('--force');

// ── Haversine (km) ─────────────────────────────────────────────────
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371, D = Math.PI / 180;
  const dl = (lat2-lat1)*D, dn = (lon2-lon1)*D;
  const a = Math.sin(dl/2)**2 + Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dn/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── GPX parser (puntos completos sin simplificar) ──────────────────
function parseGpx(content, filePath) {
  const unesc = s => s
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim();

  let name = path.basename(filePath, '.gpx');
  const trkName = content.match(/<trk\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
  if (trkName) name = unesc(trkName[1]);
  else {
    const metaName = content.match(/<metadata\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
    if (metaName) name = unesc(metaName[1]).replace(/^wikiloc\s*-\s*/i,'').trim();
  }

  let date = null;
  const mt = content.match(/<metadata\b[^>]*>[\s\S]*?<time>([^<]+)<\/time>/);
  if (mt) date = mt[1].trim().substring(0,10);
  if (!date) {
    const pt = content.match(/<trkpt\b[^>]*>[\s\S]*?<time>([^<]+)<\/time>/);
    if (pt) date = pt[1].trim().substring(0,10);
  }
  if (!date) {
    const fn = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
    if (fn) date = fn[1];
  }

  const points = [];
  let pos = 0;
  while (true) {
    const ts = content.indexOf('<trkpt', pos);
    if (ts === -1) break;
    const te = content.indexOf('>', ts);
    if (te === -1) break;
    const ce = content.indexOf('</trkpt>', te);
    const tag  = content.substring(ts, te + 1);
    const body = ce !== -1 ? content.substring(te + 1, ce) : '';
    const latM = tag.match(/\blat="([^"]+)"/);
    const lonM = tag.match(/\blon="([^"]+)"/);
    const eleM = body.match(/<ele>([^<]+)<\/ele>/);
    if (latM && lonM) {
      const lat = parseFloat(latM[1]), lon = parseFloat(lonM[1]);
      if (!isNaN(lat) && !isNaN(lon))
        points.push({ lat, lon, ele: eleM ? parseFloat(eleM[1]) : null });
    }
    pos = ce !== -1 ? ce + 8 : te + 1;
  }

  // Parse waypoints (<wpt>)
  const waypoints = [];
  let wpos = 0;
  while (true) {
    const ws = content.indexOf('<wpt', wpos);
    if (ws === -1) break;
    const wte = content.indexOf('>', ws);
    if (wte === -1) break;
    const wce  = content.indexOf('</wpt>', wte);
    const wtag  = content.substring(ws, wte + 1);
    const wbody = wce !== -1 ? content.substring(wte + 1, wce) : '';
    const wlatM = wtag.match(/\blat="([^"]+)"/);
    const wlonM = wtag.match(/\blon="([^"]+)"/);
    if (wlatM && wlonM) {
      const wlat = parseFloat(wlatM[1]), wlon = parseFloat(wlonM[1]);
      if (!isNaN(wlat) && !isNaN(wlon)) {
        const wNameM = wbody.match(/<name>([\s\S]*?)<\/name>/);
        const wEleM  = wbody.match(/<ele>([^<]+)<\/ele>/);
        const wSymM  = wbody.match(/<sym>([^<]+)<\/sym>/);
        const wDescM = wbody.match(/<desc>([\s\S]*?)<\/desc>/);
        waypoints.push({
          lat: wlat, lon: wlon,
          ele:  wEleM  ? parseFloat(wEleM[1])     : null,
          name: wNameM ? unesc(wNameM[1])           : null,
          sym:  wSymM  ? wSymM[1].trim()            : null,
          desc: wDescM ? unesc(wDescM[1])           : null,
        });
      }
    }
    wpos = wce !== -1 ? wce + 6 : wte + 1;
  }

  if (points.length < 2) return null;

  let dist = 0;
  for (let i = 1; i < points.length; i++)
    dist += hav(points[i-1].lat, points[i-1].lon, points[i].lat, points[i].lon);

  let gain = 0, loss = 0, minEle = Infinity, maxEle = -Infinity, hasEle = false;
  for (let i = 0; i < points.length; i++) {
    const e = points[i].ele;
    if (e != null && !isNaN(e)) {
      hasEle = true;
      if (e < minEle) minEle = e;
      if (e > maxEle) maxEle = e;
      if (i > 0 && points[i-1].ele != null) {
        const d = e - points[i-1].ele;
        if (d > 0) gain += d; else loss -= d;
      }
    }
  }

  let swLat=Infinity, swLon=Infinity, neLat=-Infinity, neLon=-Infinity;
  for (const p of points) {
    if (p.lat < swLat) swLat = p.lat;
    if (p.lat > neLat) neLat = p.lat;
    if (p.lon < swLon) swLon = p.lon;
    if (p.lon > neLon) neLon = p.lon;
  }

  const rel   = path.relative(path.join(__dirname,'..'), filePath).replace(/\\/g,'/');
  const parts = path.relative(TRACKS_DIR, filePath).split(path.sep);
  const zone     = parts.length > 2 ? parts[1] : null;

  return {
    name, file: rel, zone, date,
    distance:      Math.round(dist * 10) / 10,
    elevationGain: Math.round(gain),
    elevationLoss: Math.round(loss),
    minElevation:  hasEle ? Math.round(minEle) : null,
    maxElevation:  hasEle ? Math.round(maxEle) : null,
    swLat, swLon, neLat, neLon,
    centerLat: Math.round((swLat+neLat)/2 * 10000)/10000,
    centerLon: Math.round((swLon+neLon)/2 * 10000)/10000,
    circular: hav(points[0].lat, points[0].lon, points[points.length-1].lat, points[points.length-1].lon) < 0.5 ? 1 : 0,
    points, waypoints,
  };
}

// ── Recorre directorio recursivamente ─────────────────────────────
function collectGpx(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectGpx(full));
    else if (e.name.toLowerCase().endsWith('.gpx')) out.push(full);
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────
const db = openDb();

const files = collectGpx(TRACKS_DIR);
console.log(`\nEncontrados ${files.length} archivos GPX...`);

const existingFiles = new Set(
  db.prepare('SELECT file FROM tracks').all().map(r => r.file)
);

const upsertTrack = db.prepare(`
  INSERT INTO tracks
    (name,file,zone,date,distance,elevation_gain,elevation_loss,
     min_elevation,max_elevation,sw_lat,sw_lon,ne_lat,ne_lon,
     center_lat,center_lon,raw_count,cleaned,circular)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
  ON CONFLICT(file) DO UPDATE SET
    name=excluded.name, zone=excluded.zone,
    date=excluded.date, distance=excluded.distance,
    elevation_gain=excluded.elevation_gain, elevation_loss=excluded.elevation_loss,
    min_elevation=excluded.min_elevation, max_elevation=excluded.max_elevation,
    sw_lat=excluded.sw_lat, sw_lon=excluded.sw_lon,
    ne_lat=excluded.ne_lat, ne_lon=excluded.ne_lon,
    center_lat=excluded.center_lat, center_lon=excluded.center_lon,
    raw_count=excluded.raw_count, circular=excluded.circular,
    imported_at=datetime('now'), cleaned=0, clean_count=NULL, cleaned_at=NULL
`);
const insertRaw   = db.prepare('INSERT OR REPLACE INTO raw_points(track_id,seq,lat,lon,ele) VALUES(?,?,?,?,?)');
const deleteRaw   = db.prepare('DELETE FROM raw_points   WHERE track_id=?');
const deleteClean = db.prepare('DELETE FROM clean_points WHERE track_id=?');
const getTrackId  = db.prepare('SELECT id FROM tracks WHERE file=?');

function importTrack(track) {
  withTransaction(() => {
    upsertTrack.run(
      track.name, track.file, track.zone ?? null, track.date ?? null,
      track.distance, track.elevationGain, track.elevationLoss,
      track.minElevation ?? null, track.maxElevation ?? null,
      track.swLat, track.swLon, track.neLat, track.neLon,
      track.centerLat, track.centerLon, track.points.length,
      track.circular ?? 0
    );
    const row = getTrackId.get(track.file);
    deleteRaw.run(row.id);
    deleteClean.run(row.id);
    for (let i = 0; i < track.points.length; i++) {
      const p = track.points[i];
      insertRaw.run(row.id, i, p.lat, p.lon, p.ele ?? null);
    }
    if (track.waypoints && track.waypoints.length > 0) {
      db.prepare('UPDATE tracks SET waypoints_json=? WHERE id=?')
        .run(JSON.stringify(track.waypoints), row.id);
    }
  });
}

let imported = 0, skipped = 0, errors = 0;

for (const filePath of files) {
  const rel = path.relative(path.join(__dirname,'..'), filePath).replace(/\\/g,'/');
  if (!FORCE && existingFiles.has(rel)) { skipped++; continue; }
  try {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); }
    catch { content = fs.readFileSync(filePath, 'latin1'); }
    const track = parseGpx(content, filePath);
    if (!track) { console.warn(`  ⚠  Sin puntos: ${path.basename(filePath)}`); errors++; continue; }
    importTrack(track);
    imported++;
    process.stdout.write(`\r  Importados: ${imported}  `);
  } catch (e) {
    console.error(`\n  ✗ ${path.basename(filePath)}: ${e.message}`);
    errors++;
  }
}

const total = db.prepare('SELECT COUNT(*) as n FROM tracks').get().n;
console.log(`\n\n✓ Importación completada:`);
console.log(`  Nuevos/actualizados  : ${imported}`);
console.log(`  Omitidos (ya existen): ${skipped}  (usa --force para reimportar)`);
console.log(`  Errores              : ${errors}`);
console.log(`  Total en BD          : ${total} tracks\n`);
console.log(`Siguiente paso: node scripts/clean-tracks.js --help\n`);
