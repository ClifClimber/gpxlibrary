#!/usr/bin/env node
'use strict';

// Pipeline de importación desde TracksGps/_TEMP_
// 1. Reverse-geocode con Nominatim para obtener provincia/CCAA y nombre de zona
// 2. Clasifica actividad (palabras clave + métricas)
// 3. Mueve el archivo a TracksGps/<Actividad>/<Sierra>/
// 4. Se guardan en TracksGps/store/{uid}.gpx (inmutable); los dudosos llevan la etiqueta «revisar»
// 5. Importa a la BD
//
// Uso: node scripts/import-from-temp.js [--force]

const fs   = require('fs');
const path = require('path');
const { openSql } = require('../repo/sql');
const { newUid, sha256, putFile, deleteTrackFile } = require('./store');
const { parseGpx, computeMetrics, computeTimes, elapsedSeconds, timeSegments, inferActivity, sierraFromBbox,
        extractSierraFromNominatim, locationFromNominatim, computeIBP } = require('../domain');
const { CACHE_DIR, slugify }      = require('./osm-strategy-batch');
const { fetchTrackPts, filterWaysToBbox, applyWaysToTrack } = require('./osm-shared');

const CACHE_TTL_MS = 365 * 24 * 3600 * 1000;
function readOsmCache(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return (d.ts && d.ways) ? d : null; }
  catch { return null; }
}

const TRACKS_DIR = path.join(__dirname, '..', 'TracksGps');
const TEMP_DIR   = path.join(TRACKS_DIR, '_TEMP_');

const FORCE      = process.argv.includes('--force');
const KEEP_SRC   = process.argv.includes('--keep');   // copy only, don't delete source
const filesIdx   = process.argv.indexOf('--files');
const FILTER_FILES = filesIdx !== -1
  ? new Set(process.argv[filesIdx + 1].split('|'))
  : null;
const srcIdx  = process.argv.indexOf('--src');
const SRC_DIR = srcIdx !== -1 ? path.resolve(process.argv[srcIdx + 1]) : TEMP_DIR;
const ownerIdx = process.argv.indexOf('--owner');   // user who imports: owner of newly created tracks
const OWNER_ID = ownerIdx !== -1 ? parseInt(process.argv[ownerIdx + 1]) || null : null;
const ALLOW_DUP = process.argv.includes('--allow-dup');   // import even if this owner already has the same file

// ── Sierras (cargadas desde BD en tiempo de ejecución) ──────────────
let SIERRAS = [];
async function loadSierrasFromDb(db) {
  try {
    SIERRAS = (await db.all('SELECT name,sw_lat,sw_lon,ne_lat,ne_lon FROM config_sierras WHERE active=1'))
      .map(r => ({ name: r.name, sw: [r.sw_lat, r.sw_lon], ne: [r.ne_lat, r.ne_lon] }));
    if (SIERRAS.length === 0) console.warn('⚠ No hay sierras activas en config_sierras');
  } catch(e) {
    console.warn('⚠ No se pudieron cargar sierras desde BD:', e.message);
  }
}

// ── Nominatim ────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let lastNominatim = 0;

async function fetchNominatim(lat, lon) {
  const now = Date.now();
  const wait = 1100 - (now - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();

  const url  = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=es&zoom=10`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'GPXLibrary/1.0 (oscar.ramos@gmail.com)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
  return resp.json();
}

// ── GPX → datos de track (lógica pura en domain/) ────────────────
function parseTrack(content, filePath) {
  const p = parseGpx(content, { fileName: filePath });
  const m = computeMetrics(p.points);
  if (!m) return null;
  return { name: p.name, date: p.date, url: p.url, ...m, points: p.points, waypoints: p.waypoints,
           times: computeTimes(p.points), elapsed: elapsedSeconds(p.points), segments: timeSegments(p.points) };
}

// ── Recoger GPX de _TEMP_ (excluye _REVIEW_) ─────────────────────────
function collectTempGpx(dir) {
  const out = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== '_REVIEW_') out.push(...collectTempGpx(full));
      else if (e.name.toLowerCase().endsWith('.gpx')) out.push(full);
    }
  } catch {}
  return out;
}

// ── Main (async) ──────────────────────────────────────────────────────
(async () => {

  if (!fs.existsSync(SRC_DIR)) {
    console.log(`⚠  No existe la carpeta origen: ${SRC_DIR}`);
    process.exit(0);
  }

  console.log(`Carpeta origen: ${SRC_DIR}${KEEP_SRC ? ' (modo copia — archivos originales conservados)' : ' (modo mover — archivos originales se borrarán)'}`);

  let files = collectTempGpx(SRC_DIR);
  if (FILTER_FILES) {
    files = files.filter(f => FILTER_FILES.has(path.relative(SRC_DIR, f).replace(/\\/g, '/')));
  }
  if (!files.length) {
    console.log('✓ No hay archivos que importar.');
    process.exit(0);
  }

  console.log(`\nImportando ${files.length} archivo(s) GPX...\n`);

  const db = openSql();
  await loadSierrasFromDb(db); // carga sierras desde config_sierras en BD

  // Limpiar el flag de importación reciente antes de marcar los nuevos
  await db.run('UPDATE tracks SET is_recent_import=0 WHERE is_recent_import=1');

  const UPSERT = `
    INSERT INTO tracks
      (name,file,zone,date,distance,elevation_gain,elevation_loss,
       min_elevation,max_elevation,sw_lat,sw_lon,ne_lat,ne_lon,
       center_lat,center_lon,raw_count,cleaned,activity,sierra,province,ccaa,url,circular,
       ibp_bicycle,ibp_hiking,ibp_running,is_recent_import,owner_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,1,?)
    ON CONFLICT(file) DO UPDATE SET
      name=excluded.name, zone=excluded.zone,
      date=excluded.date, distance=excluded.distance,
      elevation_gain=excluded.elevation_gain, elevation_loss=excluded.elevation_loss,
      min_elevation=excluded.min_elevation, max_elevation=excluded.max_elevation,
      sw_lat=excluded.sw_lat, sw_lon=excluded.sw_lon,
      ne_lat=excluded.ne_lat, ne_lon=excluded.ne_lon,
      center_lat=excluded.center_lat, center_lon=excluded.center_lon,
      raw_count=excluded.raw_count, activity=excluded.activity,
      sierra=excluded.sierra, province=excluded.province, ccaa=excluded.ccaa,
      url=COALESCE(excluded.url, tracks.url),
      circular=excluded.circular,
      ibp_bicycle=COALESCE(excluded.ibp_bicycle, tracks.ibp_bicycle),
      ibp_hiking=COALESCE(excluded.ibp_hiking, tracks.ibp_hiking),
      ibp_running=COALESCE(excluded.ibp_running, tracks.ibp_running),
      imported_at=${db.NOW}, cleaned=0, clean_count=NULL, cleaned_at=NULL,
      is_recent_import=1
    RETURNING id
  `;

  async function importTrack(track, relFile, activity, sierra, province, ccaa, ibp) {
    return db.tx(async t => {
      const parts = relFile.split('/');
      const zone   = parts.length > 3 ? parts[2] : null;
      const row = await t.get(UPSERT, [
        track.name, relFile, zone, track.date ?? null,
        track.distance, track.elevationGain, track.elevationLoss,
        track.minElevation ?? null, track.maxElevation ?? null,
        track.swLat, track.swLon, track.neLat, track.neLon,
        track.centerLat, track.centerLon, track.points.length,
        activity ?? null, sierra ?? null, province ?? null, ccaa ?? null,
        track.url ?? null, track.circular ?? 0,
        ibp.ibp_bicycle ?? null, ibp.ibp_hiking ?? null, ibp.ibp_running ?? null,
        OWNER_ID,
      ]);
      await t.setPoints(row.id, track.points);
      await t.setPoints(row.id, [], { clean: true });
      if (track.waypoints && track.waypoints.length > 0) {
        await t.run('UPDATE tracks SET waypoints_json=? WHERE id=?', [JSON.stringify(track.waypoints), row.id]);
      }
      return row.id;
    });
  }

  let imported = 0, skipped = 0, reviewed = 0, errors = 0;
  const importedIds = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const baseName = path.basename(filePath);
    console.log(`[${i+1}/${files.length}] ${baseName}`);

    // Leer GPX
    let content, hash;
    try {
      const buf = fs.readFileSync(filePath);
      hash = sha256(buf);
      content = buf.toString('utf8');
      if (content.includes('�')) content = buf.toString('latin1');
    } catch (e) { console.log(`  ✗ No se puede leer: ${e.message}`); errors++; continue; }

    // Duplicates (byte-identical GPX) are per owner: someone else's or a public base route can be
    // imported again as your own; your own copy is reported (DUPLICATE_OWN) unless --allow-dup.
    const dup = FORCE || ALLOW_DUP ? null : OWNER_ID
      ? await db.get('SELECT id, name FROM tracks WHERE sha256=? AND owner_id=? LIMIT 1', [hash, OWNER_ID])
      : await db.get('SELECT id, name FROM tracks WHERE sha256=? LIMIT 1', [hash]);
    if (dup) {
      if (!KEEP_SRC) { try { fs.unlinkSync(filePath); } catch {} }
      console.log(`  ↩ Ya existe en BD (mismo contenido que id=${dup.id} «${dup.name}»)${KEEP_SRC ? '' : ' · copia descartada'}`);
      if (OWNER_ID) console.log(`DUPLICATE_OWN:${dup.id}`);
      skipped++; continue;
    }

    let track;
    try {
      track = parseTrack(content, filePath);
      if (!track) { console.log(`  ⚠ Sin puntos de track`); errors++; continue; }
    } catch (e) { console.log(`  ✗ Error parseando: ${e.message}`); errors++; continue; }

    console.log(`  Métricas  : ${track.distance} km  /  +${track.elevationGain}m  (centro: ${track.centerLat}, ${track.centerLon})`);

    // ── Paso 1: Obtener datos geográficos con Nominatim ─────────────
    let province = null, ccaa = null, sierraNominatim = null;
    try {
      console.log(`  Consultando Nominatim...`);
      const geo = await fetchNominatim(track.centerLat, track.centerLon);
      ({ province, ccaa } = locationFromNominatim(geo));
      sierraNominatim = extractSierraFromNominatim(geo);
      if (province || ccaa) console.log(`  Ubicación  : ${[province, ccaa].filter(Boolean).join(', ')}`);
    } catch (e) {
      console.log(`  ⚠ Nominatim no disponible: ${e.message}`);
    }

    // ── Paso 2: Determinar sierra (Nominatim → bounding box) ────────
    const sierra = sierraNominatim || sierraFromBbox(track.centerLat, track.centerLon, SIERRAS);
    console.log(`  Sierra     : ${sierra || 'no detectada'}`);

    // ── Paso 3: Inferir actividad ────────────────────────────────────
    const { act, conf } = inferActivity(track.name, track.distance, track.elevationGain);
    console.log(`  Actividad  : ${act} (${conf})`);

    // ── Paso 4: Guardar en el almacén inmutable ─────────────────────
    const needsReview = conf === 'low' && !sierra;
    if (needsReview) { console.log(`  → ⚠ Por revisar (baja confianza, sin zona geográfica)`); reviewed++; }
    const uid = newUid();
    let relFile;
    try { relFile = await putFile(filePath, uid, { keep: true }); }
    catch (e) { console.log(`  ✗ Error guardando: ${e.message}`); errors++; continue; }

    // ── Paso 6: Importar a BD y escribir atributos al GPX ───────────
    const ibp = computeIBP(track.distance, track.elevationGain);
    console.log(`  IBP        : h=${ibp.ibp_hiking}  b=${ibp.ibp_bicycle}  r=${ibp.ibp_running}`);
    try {
      const newId = await importTrack(track, relFile, act, sierra, province, ccaa, ibp);
      await db.run('UPDATE tracks SET uid=?, sha256=?, zone=COALESCE(zone, sierra) WHERE id=?', [uid, hash, newId]);
      if (track.times) await db.run('UPDATE tracks SET moving_time=?, stopped_time=? WHERE id=?', [track.times.moving, track.times.stopped, newId]);
      if (track.elapsed) await db.run('UPDATE tracks SET elapsed_time=?, time_segments=? WHERE id=?',
        [track.elapsed, track.segments ? JSON.stringify(track.segments) : null, newId]);
      if (needsReview) await db.run('UPDATE tracks SET tags=? WHERE id=?', [JSON.stringify(['revisar']), newId]);
      importedIds.push(newId);
      imported++;
      if (!KEEP_SRC) { try { fs.unlinkSync(filePath); } catch {} }
      console.log(`  ✓ Importado (id=${newId})`);

      // Auto-enrich with OSM road types from batch-sierra cache if available
      try {
        const slug      = slugify(sierra || province || 'sin-zona');
        const cacheFile = require('path').join(CACHE_DIR, slug + '.json');
        const cached    = readOsmCache(cacheFile);
        if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
          const trackRow = await db.get('SELECT id,sw_lat,sw_lon,ne_lat,ne_lon,cleaned FROM tracks WHERE id=?', [newId]);
          const fWays = filterWaysToBbox(cached.ways, trackRow);
          const pts   = await fetchTrackPts(trackRow, db, 1500);
          if (pts.length >= 2) {
            await applyWaysToTrack(trackRow, pts, fWays, db);
            console.log(`  OSM        : ${fWays.length} vías aplicadas (caché)`);
          } else {
            console.log(`  OSM        : sin puntos GPS (no calculado)`);
          }
        } else if (cached) {
          console.log(`  OSM        : caché obsoleta para ${sierra || province || 'zona'}`);
        } else {
          console.log(`  OSM        : sin caché para ${sierra || province || 'zona'}`);
        }
      } catch (osmErr) {
        console.log(`  OSM        : error al aplicar caché (${osmErr.message})`);
      }

    } catch (e) {
      console.log(`  ✗ Error en BD: ${e.message}`);
      errors++;
      await deleteTrackFile(relFile).catch(() => {});   // the source stays in _TEMP_ for a retry
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✓ Importación completada:`);
  console.log(`  Importados          : ${imported}`);
  console.log(`  Ya existían (BD)    : ${skipped}`);
  console.log(`  Por revisar         : ${reviewed}`);
  console.log(`  Errores             : ${errors}`);
  if (reviewed > 0) {
    console.log(`\n⚠  ${reviewed} tracks con la etiqueta «revisar» necesitan clasificación manual.`);
  }
  if (importedIds.length > 0) {
    console.log(`IMPORTED_IDS:${importedIds.join(',')}`);
  }
  console.log('');
  await db.close();
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
