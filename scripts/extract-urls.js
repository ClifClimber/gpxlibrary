'use strict';
// Escanea todos los GPX y extrae la mejor URL de la fuente original del track.
// Actualiza el campo `url` en la BD solo si el track aún no tiene URL.
// Uso: node scripts/extract-urls.js [--force] [--dry-run]

const fs   = require('fs');
const path = require('path');
const { openSql } = require('../repo/sql');
const { readTrackFile, gpxText } = require('./store');

const ROOT    = path.join(__dirname, '..');

const args    = process.argv.slice(2);
const force   = args.includes('--force');
const dryRun  = args.includes('--dry-run');

// ── Heurística: puntúa una URL para decidir si es un link de track ──
function scoreUrl(raw) {
  if (!raw) return -1;
  let url;
  try { url = new URL(raw); } catch { return -1; }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const full = raw.toLowerCase();

  // Descartar perfiles de usuario
  if (full.includes('/user.do?id=') || full.includes('/users/') ||
      full.includes('/profile/') || full.includes('/wikiloc/user.do')) return -1;

  // Descartar raíces genéricas (sin path significativo)
  const genericHosts = ['www.komoot.de','komoot.de','www.garmin.com','garmin.com',
    'gpx.studio','www.compegps.com','compegps.com','www.gpsies.com','gpsies.com',
    'maps.google.com','www.google.com'];
  if (genericHosts.some(h => host === h) && (path === '/' || path.length < 2)) return -1;

  // Descartar trailforks genérico / planner
  if (host.includes('trailforks') && (path === '/' || path.includes('/planner'))) return -1;

  // Descartar fotos
  if (host.includes('picasaweb') || host.includes('flickr') || host.includes('instagram')) return -1;

  // Wikiloc track específico  (ej: .../mountain-biking-trails/nombre-NNNNN)
  if (host.includes('wikiloc') && path.length > 6) return 10;

  // Strava ruta / actividad
  if (host.includes('strava') && (path.includes('/routes/') || path.includes('/activities/'))) return 9;

  // Komoot ruta específica
  if (host.includes('komoot') && path.length > 5) return 8;

  // Trailforks trail específico
  if (host.includes('trailforks') && path.length > 5) return 7;

  // Blog / web con path largo (ej: maparutasmtb.blogspot.com/2014/06/nombre.html)
  if (path.length > 10 && !host.includes('topografix') &&
      !host.includes('w3.org') && !host.includes('schemas')) return 5;

  return -1;
}

// ── Extrae todos los href de <link> dentro de <metadata> ──────────
function extractLinks(content) {
  const links = [];
  // Buscar la sección <metadata>...</metadata>
  const metaStart = content.indexOf('<metadata');
  const metaEnd   = content.indexOf('</metadata>');
  const zone = metaEnd > metaStart ? content.slice(metaStart, metaEnd + 11) : content.slice(0, 2000);

  let pos = 0;
  while (true) {
    const li = zone.indexOf('<link', pos);
    if (li === -1) break;
    const hrefStart = zone.indexOf('href="', li);
    if (hrefStart === -1) { pos = li + 5; continue; }
    const valStart = hrefStart + 6;
    const valEnd   = zone.indexOf('"', valStart);
    if (valEnd === -1) { pos = li + 5; continue; }
    links.push(zone.slice(valStart, valEnd));
    pos = valEnd + 1;
  }
  return links;
}

// ── Elige la mejor URL de la lista ───────────────────────────────
function bestUrl(links) {
  let best = null, bestScore = -1;
  for (const l of links) {
    const s = scoreUrl(l);
    if (s > bestScore) { bestScore = s; best = l; }
  }
  return best;
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
const db     = openSql();
const tracks = await db.all(
  force ? 'SELECT id, file, url FROM tracks ORDER BY id'
        : 'SELECT id, file, url FROM tracks WHERE url IS NULL ORDER BY id');


console.log(`Buscando URLs en ${tracks.length} tracks${force ? ' (todos)' : ' (sin URL)'}${dryRun ? ' [dry-run]' : ''}...`);

let found = 0, notFound = 0, skipped = 0;


for (const t of tracks) {
  const buf = await readTrackFile(t.file);
  if (!buf) { skipped++; continue; }
  const content = gpxText(buf);

  const links = extractLinks(content);
  const url   = bestUrl(links);

  if (url) {
    if (!dryRun) await db.run('UPDATE tracks SET url=? WHERE id=?', [url, t.id]);
    found++;
    console.log(`✓ [${t.id}] ${path.basename(t.file, '.gpx').substring(0, 45)}`);
    console.log(`    → ${url}`);
  } else {
    notFound++;
    if (links.length > 0) {
      console.log(`  [${t.id}] Sin URL útil (${links.length} links descartados: ${links.join(', ').substring(0, 80)})`);
    }
  }
}

console.log(`\n✓ URLs encontradas: ${found}  |  Sin URL: ${notFound}  |  Saltados: ${skipped}`);
await db.close();
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
