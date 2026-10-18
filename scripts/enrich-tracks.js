'use strict';
// Enriquece los tracks con datos geográficos (provincia, CCAA) via Nominatim
// y deduce actividad + sierra a partir de categoría/zona/coordenadas.
// Uso: node scripts/enrich-tracks.js [--all] [--dry-run] [--track-id N]
const { openDb } = require('./db');

let SIERRAS = [];
function loadSierrasFromDb() {
  try {
    const db = openDb();
    SIERRAS = db.prepare('SELECT name,sw_lat,sw_lon,ne_lat,ne_lon FROM config_sierras WHERE active=1').all()
      .map(r => ({ name: r.name, sw: [r.sw_lat, r.sw_lon], ne: [r.ne_lat, r.ne_lon] }));
  } catch(e) {
    console.warn('⚠ No se pudieron cargar sierras desde BD:', e.message);
  }
}
loadSierrasFromDb();

function inferSierraFromZone(zone) {
  if (!zone) return null;
  const z = zone.toLowerCase();
  if (z.includes('gredos'))                              return 'Sierra de Gredos';
  if (z.includes('guadarrama'))                          return 'Sierra de Guadarrama';
  if (z.includes('sierra norte'))                        return 'Sierra Norte de Madrid';
  if (z.includes('ayllón') || z.includes('aylon'))       return 'Sierra de Ayllón';
  if (z.includes('béjar') || z.includes('bejar') || z.includes('candelario')) return 'Sierra de Béjar';
  if (z.includes('tramuntana'))                          return 'Serra de Tramuntana';
  if (z.includes('nevada'))                              return 'Sierra Nevada';
  if (z.includes('picos'))                               return 'Picos de Europa';
  if (z.includes('pirineos') || z.includes('pireneu'))   return 'Pirineos';
  if (z.includes('morena'))                              return 'Sierra Morena';
  if (z.includes('cazorla'))                             return 'Sierra de Cazorla';
  if (z.includes('galicia') || z.includes('faros') || z.includes('muxia')) return 'Costa da Morte';
  if (z.includes('cantabria') || z.includes('cantábrica'))  return 'Cordillera Cantábrica';
  if (z.includes('toledo'))                              return 'Montes de Toledo';
  return null;
}

function inferSierraFromCoords(lat, lon) {
  for (const z of SIERRAS) {
    if (lat >= z.sw[0] && lat <= z.ne[0] && lon >= z.sw[1] && lon <= z.ne[1]) return z.name;
  }
  return null;
}

function inferActivity(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('gravel'))                              return 'Gravel';
  if (n.includes('escalad'))                             return 'Escalada';
  if (n.includes('senderism') || n.includes('sendero')) return 'Senderismo';
  if (/\bcamino\b|\bcaminó\b/.test(n))                  return 'Senderismo';
  if (n.includes('kayak') || n.includes('pirag'))        return 'Kayak';
  if (n.includes('esqui') || n.includes('esquí'))        return 'Esquí de montaña';
  if (n.includes('running'))                             return 'Running';
  if (n.includes('carretera') || n.includes('road'))     return 'Ciclismo de carretera';
  if (n.includes('mtb') || n.includes('btt'))            return 'MTB';
  if (n.includes('bikepacking'))                         return 'Bikepacking';
  return 'Otro';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchNominatim(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=es`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'GPXLibrary/1.0' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function parseAddress(addr = {}) {
  let province = addr.county || addr.state_district || null;
  const ccaa   = addr.state || null;
  if (province) province = province.replace(/^Provincia de /i,'').replace(/^Provincia d['e]? ?/i,'').trim();
  return { province, ccaa };
}

const args    = process.argv.slice(2);
const forceAll = args.includes('--all');
const dryRun  = args.includes('--dry-run');
const trackId = (() => { const i = args.indexOf('--track-id'); return i >= 0 ? parseInt(args[i+1]) : null; })();
// --ids 1,2,3 → enriquecer solo esos IDs (forzando re-enriquecimiento)
const idsArg  = (() => { const i = args.indexOf('--ids'); return i >= 0 ? args[i+1] : null; })();

(async () => {
  const db = openDb();
  // "activity IS NULL" = nunca procesado (activity siempre se infiere, incluso sin red)
  let where = 'WHERE center_lat IS NOT NULL';
  if (idsArg) {
    const safeIds = idsArg.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)).join(',');
    where += safeIds ? ` AND id IN (${safeIds})` : ' AND 0';
  } else if (trackId) {
    where += ` AND id=${trackId}`;
  } else if (!forceAll) {
    where += ` AND activity IS NULL`;
  }

  const tracks = db.prepare(
    `SELECT id, name, zone, center_lat, center_lon, activity, province, ccaa, sierra FROM tracks ${where} ORDER BY id`
  ).all();

  console.log(`Enriqueciendo ${tracks.length} tracks${forceAll ? ' (todos)' : ' (sin datos)'}${dryRun ? ' [dry-run]' : ''}...`);
  if (!tracks.length) { console.log('✓ Nada que procesar.'); return; }

  const updStmt = dryRun ? null : db.prepare(
    'UPDATE tracks SET activity=?, province=?, ccaa=?, sierra=? WHERE id=?'
  );

  let ok = 0, errs = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const activity = t.activity && !forceAll ? t.activity : inferActivity(t.name);
    const sierra   = (t.sierra && !forceAll) ? t.sierra :
                     inferSierraFromZone(t.zone) || inferSierraFromCoords(t.center_lat, t.center_lon);

    let province = t.province, ccaa = t.ccaa;

    if (!province || !ccaa || forceAll) {
      try {
        const data = await fetchNominatim(t.center_lat, t.center_lon);
        const parsed = parseAddress(data.address);
        province = parsed.province || province;
        ccaa     = parsed.ccaa     || ccaa;
        await sleep(1100);
      } catch (e) {
        // Error de red: guardamos igualmente activity y sierra (inferidos localmente)
        process.stderr.write(`✗ [${t.id}] ${t.name}: ${e.message}\n`);
        errs++;
        await sleep(2200);
      }
    }

    // Siempre guardar — aunque Nominatim falle, activity y sierra ya tienen valor
    if (!dryRun) updStmt.run(activity, province, ccaa, sierra, t.id);
    ok++;
    process.stdout.write(`\rProcesados: ${i + 1}/${tracks.length}`);
    if ((i + 1) % 25 === 0 || i + 1 === tracks.length) {
      process.stdout.write(`\n✓ ${i + 1}/${tracks.length} — ${t.name.substring(0, 55)}\n`);
    }
  }

  console.log(`\n✓ Enriquecimiento completado: ${ok} OK, ${errs} errores`);
})().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
