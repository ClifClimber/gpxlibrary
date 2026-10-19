#!/usr/bin/env node
'use strict';

// Pipeline de importación desde TracksGps/_TEMP_
// 1. Reverse-geocode con Nominatim para obtener provincia/CCAA y nombre de zona
// 2. Clasifica actividad (palabras clave + métricas)
// 3. Mueve el archivo a TracksGps/<Actividad>/<Sierra>/
// 4. Los que no se pueden clasificar van a _TEMP_/_REVIEW_
// 5. Importa a la BD
//
// Uso: node scripts/import-from-temp.js [--force]

const fs   = require('fs');
const path = require('path');
const { openDb, withTransaction } = require('./db');
const { updateGpxMetadata }       = require('./gpx-utils');

const TRACKS_DIR = path.join(__dirname, '..', 'TracksGps');
const TEMP_DIR   = path.join(TRACKS_DIR, '_TEMP_');
const REVIEW_DIR = path.join(TEMP_DIR, '_REVIEW_');
const FORCE      = process.argv.includes('--force');
const filesIdx   = process.argv.indexOf('--files');
const FILTER_FILES = filesIdx !== -1
  ? new Set(process.argv[filesIdx + 1].split('|'))
  : null;

// ── Sierras (cargadas desde BD en tiempo de ejecución) ──────────────
let SIERRAS = [];
function loadSierrasFromDb() {
  try {
    const db = openDb();
    SIERRAS = db.prepare('SELECT name,sw_lat,sw_lon,ne_lat,ne_lon FROM config_sierras WHERE active=1').all()
      .map(r => ({ name: r.name, sw: [r.sw_lat, r.sw_lon], ne: [r.ne_lat, r.ne_lon] }));
    if (SIERRAS.length === 0) console.warn('⚠ No hay sierras activas en config_sierras');
  } catch(e) {
    console.warn('⚠ No se pudieron cargar sierras desde BD:', e.message);
  }
}

// Palabras que indican nombre de sierra en el display_name de Nominatim
const SIERRA_KEYWORDS = [
  'Sierra de ','Sierra del ','Sierras de ','Serra de ','Serra del ',
  'Macizo de ','Macizo del ','Picos de ','Cordillera ','Sistema ',
  'Montes de ','Montes del ',
];

function sierraFromBbox(lat, lon) {
  for (const z of SIERRAS) {
    if (lat >= z.sw[0] && lat <= z.ne[0] && lon >= z.sw[1] && lon <= z.ne[1]) return z.name;
  }
  return null;
}

function extractSierraFromNominatim(data) {
  if (!data) return null;
  // municipality puede ser nombre de sierra en algunas áreas
  const candidates = [
    data.address?.municipality,
    data.address?.county,
    data.address?.state_district,
    ...(data.display_name || '').split(',').map(s => s.trim()),
  ].filter(Boolean);

  for (const kw of SIERRA_KEYWORDS) {
    for (const c of candidates) {
      if (c.includes(kw)) {
        // Devuelve hasta 4 palabras desde la keyword
        const idx = c.indexOf(kw);
        const raw = c.substring(idx).split(',')[0].trim();
        // Limitar longitud razonable
        const words = raw.split(' ').slice(0, 5);
        return words.join(' ');
      }
    }
  }
  return null;
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

// ── Actividad por nombre + métricas ─────────────────────────────────
function inferActivity(name, dist, gain) {
  const n = (name || '').toLowerCase();

  if (n.includes('gravel'))                              return { act: 'Gravel',                  conf: 'high' };
  if (n.includes('escalad') || n.includes('climbing'))  return { act: 'Escalada',                conf: 'high' };
  if (n.includes('esquí') || n.includes('esqui') || /\bski\b/.test(n)) return { act: 'Esquí de montaña', conf: 'high' };
  if (/trail.?run|running/.test(n))                     return { act: 'Trail Running',            conf: 'high' };
  if (n.includes('senderism') || /\bcaminata\b/.test(n)) return { act: 'Senderismo',             conf: 'high' };
  if (/\bcamino\b/.test(n) && !n.includes('carretera')) return { act: 'Senderismo',               conf: 'high' };
  if (n.includes('carretera') || n.includes('ciclism'))  return { act: 'Ciclismo de carretera',  conf: 'high' };
  if (n.includes('mtb') || n.includes('mountain bike') || n.includes('btt')) return { act: 'Mtb', conf: 'high' };
  if (n.includes('bikepacking'))                         return { act: 'Bikepacking',             conf: 'high' };
  if (n.includes('kayak') || n.includes('pirag'))        return { act: 'Kayak',                  conf: 'high' };

  const gpk = dist > 0 ? gain / dist : 0;

  if (dist > 100) return gpk < 15
    ? { act: 'Ciclismo de carretera', conf: 'medium' }
    : { act: 'MTB',                   conf: 'medium' };
  if (dist > 50) {
    if (gpk < 20) return { act: 'Ciclismo de carretera', conf: 'medium' };
    if (gpk < 50) return { act: 'MTB',                   conf: 'medium' };
    return         { act: 'Trail Running',                conf: 'medium' };
  }
  if (dist > 20) {
    if (gpk > 60) return { act: 'Trail Running', conf: 'medium' };
    if (gpk > 25) return { act: 'Senderismo',    conf: 'medium' };
    return         { act: 'MTB',                 conf: 'low'    };
  }
  return gpk > 60
    ? { act: 'Senderismo', conf: 'medium' }
    : { act: 'Senderismo', conf: 'low'    };
}

// ── Nombre seguro para carpetas Windows ─────────────────────────────
function safeFolderName(s) {
  return (s || 'General').replace(/[<>:"/\\|?*]/g, '_').trim() || 'General';
}

// ── Haversine ────────────────────────────────────────────────────────
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371, D = Math.PI / 180;
  const dl = (lat2-lat1)*D, dn = (lon2-lon1)*D;
  const a = Math.sin(dl/2)**2 + Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dn/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Parser GPX ───────────────────────────────────────────────────────
function parseGpx(content, filePath) {
  const unesc = s => s
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim();

  let name = path.basename(filePath, '.gpx');
  const trkName = content.match(/<trk\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
  if (trkName) name = unesc(trkName[1]);
  else {
    const mn = content.match(/<metadata\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
    if (mn) name = unesc(mn[1]).replace(/^wikiloc\s*-\s*/i,'').trim();
  }

  // URL desde <metadata><link href="..."> o <trk><link href="...">
  let sourceUrl = null;
  const metaLink = content.match(/<metadata\b[^>]*>[\s\S]*?<link\s[^>]*href="([^"]+)"/);
  if (metaLink) sourceUrl = metaLink[1].trim();
  if (!sourceUrl) {
    const trkLink = content.match(/<trk\b[^>]*>[\s\S]*?<link\s[^>]*href="([^"]+)"/);
    if (trkLink) sourceUrl = trkLink[1].trim();
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
    const ce  = content.indexOf('</trkpt>', te);
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

  return {
    name, origFile: filePath, date, url: sourceUrl,
    distance:      Math.round(dist * 10) / 10,
    elevationGain: Math.round(gain),
    elevationLoss: Math.round(loss),
    minElevation:  hasEle ? Math.round(minEle) : null,
    maxElevation:  hasEle ? Math.round(maxEle) : null,
    swLat, swLon, neLat, neLon,
    centerLat: Math.round((swLat+neLat)/2 * 10000)/10000,
    centerLon: Math.round((swLon+neLon)/2 * 10000)/10000,
    points,
  };
}

// ── Mover archivo con manejo de colisiones ────────────────────────────
function moveFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(src);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest) && dest !== src) {
    const ext  = path.extname(base);
    const stem = path.basename(base, ext);
    let n = 2;
    while (fs.existsSync(path.join(destDir, `${stem}_${n}${ext}`))) n++;
    dest = path.join(destDir, `${stem}_${n}${ext}`);
  }
  try { fs.renameSync(src, dest); }
  catch { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
  return dest;
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
  loadSierrasFromDb(); // carga sierras desde config_sierras en BD

  if (!fs.existsSync(TEMP_DIR)) {
    console.log('⚠  No existe TracksGps/_TEMP_ — crea la carpeta y coloca los GPX dentro.');
    process.exit(0);
  }

  let files = collectTempGpx(TEMP_DIR);
  if (FILTER_FILES) {
    files = files.filter(f => FILTER_FILES.has(path.relative(TEMP_DIR, f).replace(/\\/g, '/')));
  }
  if (!files.length) {
    console.log('✓ No hay archivos que importar.');
    process.exit(0);
  }

  console.log(`\nImportando ${files.length} archivo(s) GPX...\n`);

  const db = openDb();
  const existingFiles = new Set(
    db.prepare('SELECT file FROM tracks').all().map(r => r.file)
  );

  const upsertTrack = db.prepare(`
    INSERT INTO tracks
      (name,file,zone,date,distance,elevation_gain,elevation_loss,
       min_elevation,max_elevation,sw_lat,sw_lon,ne_lat,ne_lon,
       center_lat,center_lon,raw_count,cleaned,activity,sierra,province,ccaa,url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)
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
      imported_at=datetime('now'), cleaned=0, clean_count=NULL, cleaned_at=NULL
  `);
  const insertRaw   = db.prepare('INSERT OR REPLACE INTO raw_points(track_id,seq,lat,lon,ele) VALUES(?,?,?,?,?)');
  const deleteRaw   = db.prepare('DELETE FROM raw_points   WHERE track_id=?');
  const deleteClean = db.prepare('DELETE FROM clean_points WHERE track_id=?');
  const getTrackId  = db.prepare('SELECT id FROM tracks WHERE file=?');

  function importTrack(track, relFile, activity, sierra, province, ccaa) {
    let trackId;
    withTransaction(() => {
      const parts = relFile.split('/');
      const zone   = parts.length > 3 ? parts[2] : null;
      upsertTrack.run(
        track.name, relFile, zone, track.date ?? null,
        track.distance, track.elevationGain, track.elevationLoss,
        track.minElevation ?? null, track.maxElevation ?? null,
        track.swLat, track.swLon, track.neLat, track.neLon,
        track.centerLat, track.centerLon, track.points.length,
        activity ?? null, sierra ?? null, province ?? null, ccaa ?? null,
        track.url ?? null
      );
      const row = getTrackId.get(relFile);
      trackId = row.id;
      deleteRaw.run(row.id);
      deleteClean.run(row.id);
      for (let i = 0; i < track.points.length; i++) {
        const p = track.points[i];
        insertRaw.run(row.id, i, p.lat, p.lon, p.ele ?? null);
      }
    });
    return trackId;
  }

  let imported = 0, skipped = 0, reviewed = 0, errors = 0;
  const importedIds = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const baseName = path.basename(filePath);
    console.log(`[${i+1}/${files.length}] ${baseName}`);

    // Leer GPX
    let content;
    try {
      try { content = fs.readFileSync(filePath, 'utf8'); }
      catch { content = fs.readFileSync(filePath, 'latin1'); }
    } catch (e) { console.log(`  ✗ No se puede leer: ${e.message}`); errors++; continue; }

    let track;
    try {
      track = parseGpx(content, filePath);
      if (!track) { console.log(`  ⚠ Sin puntos de track`); errors++; continue; }
    } catch (e) { console.log(`  ✗ Error parseando: ${e.message}`); errors++; continue; }

    console.log(`  Métricas  : ${track.distance} km  /  +${track.elevationGain}m  (centro: ${track.centerLat}, ${track.centerLon})`);

    // ── Paso 1: Obtener datos geográficos con Nominatim ─────────────
    let province = null, ccaa = null, sierraNominatim = null;
    try {
      console.log(`  Consultando Nominatim...`);
      const geo = await fetchNominatim(track.centerLat, track.centerLon);
      const addr = geo.address || {};
      province = addr.county || addr.state_district || null;
      if (province) province = province.replace(/^Provincia de /i,'').trim();
      ccaa = addr.state || null;
      sierraNominatim = extractSierraFromNominatim(geo);
      if (province || ccaa) console.log(`  Ubicación  : ${[province, ccaa].filter(Boolean).join(', ')}`);
    } catch (e) {
      console.log(`  ⚠ Nominatim no disponible: ${e.message}`);
    }

    // ── Paso 2: Determinar sierra (Nominatim → bounding box) ────────
    const sierra = sierraNominatim || sierraFromBbox(track.centerLat, track.centerLon);
    console.log(`  Sierra     : ${sierra || 'no detectada'}`);

    // ── Paso 3: Inferir actividad ────────────────────────────────────
    const { act, conf } = inferActivity(track.name, track.distance, track.elevationGain);
    console.log(`  Actividad  : ${act} (${conf})`);

    // ── Paso 4: Decidir destino ──────────────────────────────────────
    let destDir;
    if (conf === 'low' && !sierra) {
      destDir = REVIEW_DIR;
      console.log(`  → ⚠ _REVIEW_ (baja confianza, sin zona geográfica)`);
      reviewed++;
    } else {
      const actFolder    = safeFolderName(act);
      const sierraFolder = safeFolderName(sierra || 'General');
      destDir = path.join(TRACKS_DIR, actFolder, sierraFolder);
      console.log(`  → ${actFolder}/${sierraFolder}/`);
    }

    // ── Paso 5: Mover archivo ────────────────────────────────────────
    let movedFile;
    try { movedFile = moveFile(filePath, destDir); }
    catch (e) { console.log(`  ✗ Error moviendo: ${e.message}`); errors++; continue; }

    const relFile = path.relative(path.join(__dirname,'..'), movedFile).replace(/\\/g,'/');

    if (!FORCE && existingFiles.has(relFile)) {
      console.log(`  ↩ Ya existe en BD`);
      skipped++;
      continue;
    }

    // ── Paso 6: Importar a BD y escribir atributos al GPX ───────────
    try {
      const newId = importTrack(track, relFile, act, sierra, province, ccaa);
      importedIds.push(newId);
      imported++;
      console.log(`  ✓ Importado (id=${newId})`);
      const gf = { name: track.name, activity: act };
      if (track.url) gf.url = track.url;
      updateGpxMetadata(movedFile, gf);
    } catch (e) {
      console.log(`  ✗ Error en BD: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✓ Importación completada:`);
  console.log(`  Importados          : ${imported}`);
  console.log(`  Ya existían (BD)    : ${skipped}`);
  console.log(`  Enviados a _REVIEW_ : ${reviewed}`);
  console.log(`  Errores             : ${errors}`);
  if (reviewed > 0) {
    console.log(`\n⚠  ${reviewed} tracks en _TEMP_/_REVIEW_ necesitan clasificación manual.`);
  }
  if (importedIds.length > 0) {
    console.log(`IMPORTED_IDS:${importedIds.join(',')}`);
  }
  console.log('');
})();
