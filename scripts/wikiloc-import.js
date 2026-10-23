#!/usr/bin/env node
'use strict';
// Descarga un track de Wikiloc y lo importa en la BD.
// Uso: node scripts/wikiloc-import.js <url-o-id>
//
// Estrategia:
//   1. Descarga pública (sin token): download.do?id=ID con cabeceras de navegador
//   2. Si falla → API oficial con Bearer token (requiere wikiloc_token en osm-settings.json)

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, 'TracksGps', '_TEMP_');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseId(str) {
  str = str.trim();
  if (/^\d+$/.test(str)) return str;
  const m = str.match(/[\/-](\d+)\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

// Extrae <name> del GPX para usarlo como nombre del archivo
function extractGpxName(gpx) {
  const m = gpx.match(/<name>([^<]{1,120})<\/name>/);
  return m ? m[1].trim() : null;
}

function isValidGpx(text) {
  return typeof text === 'string' && text.includes('<gpx') && (text.includes('<trkpt') || text.includes('<wpt'));
}

// ── Método A: intentos sin token ─────────────────────────────────────
async function fetchPublicGpx(id) {
  // A1 — URL de descarga directa (funciona si Wikiloc no requiere login para el track)
  for (const base of ['https://www.wikiloc.com', 'https://es.wikiloc.com']) {
    try {
      const resp = await fetch(`${base}/wikiloc/download.do?id=${id}`, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/gpx+xml,text/xml,*/*', 'Referer': `${base}/` },
        redirect: 'follow',
      });
      if (resp.ok) {
        const text = await resp.text();
        if (isValidGpx(text)) return text;
      }
    } catch {}
  }

  // A2 — API v2 sin autenticación (funciona para tracks públicos en algunas cuentas)
  try {
    const resp = await fetch(`https://api.wikiloc.com/api/v2/trails/${id}/gpx`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/gpx+xml,text/xml,*/*' },
    });
    if (resp.ok) {
      const text = await resp.text();
      if (isValidGpx(text)) return text;
    }
  } catch {}

  return null;
}

// ── Método B: API oficial con Bearer token ──────────────────────────
async function apiFetch(url, token, asText = false) {
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': asText ? 'application/gpx+xml,text/xml,*/*' : 'application/json',
    },
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`Wikiloc API ${resp.status}: ${msg.substring(0, 200)}`);
  }
  return asText ? resp.text() : resp.json();
}

async function fetchApiGpx(id, token) {
  const info = await apiFetch(`https://api.wikiloc.com/api/v2/trails/${id}`, token);
  const name = info.name || null;
  const gpx  = await apiFetch(`https://api.wikiloc.com/api/v2/trails/${id}/gpx`, token, true);
  return { gpx, name };
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];
  if (!arg) { console.log('⚠ Falta la URL o ID de Wikiloc'); process.exit(1); }

  const id = parseId(arg);
  if (!id) { console.log(`⚠ No se pudo extraer el ID de Wikiloc de: ${arg}`); process.exit(1); }

  // Token opcional (para fallback)
  const sf = path.join(ROOT, 'osm-settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {}
  const token = settings.wikiloc_token || null;

  console.log(`Descargando track Wikiloc #${id}…`);

  let gpx = null;
  let name = null;

  // — Intento A: descarga pública —
  console.log('  Probando descarga pública…');
  try {
    gpx = await fetchPublicGpx(id);
    if (gpx) {
      name = extractGpxName(gpx);
      console.log(`  ✓ Descarga pública OK${name ? ` → "${name}"` : ''}`);
    } else {
      console.log('  ⚠ El track no es público o requiere login');
    }
  } catch (e) {
    console.log(`  ⚠ Descarga pública falló: ${e.message}`);
  }

  // — Intento B: API con token (si A falló) —
  if (!gpx) {
    if (!token) {
      console.log('✗ Wikiloc requiere autenticación para descargar este track.');
      console.log('  (Wikiloc exige login incluso para tracks públicos al descargar GPX)');
      console.log('  Opciones:');
      console.log('  · Descarga el GPX manualmente desde wikiloc.com e impórtalo desde disco');
      console.log('  · O configura un token de API en Config → Wikiloc');
      process.exit(1);
    }
    console.log('  Usando API oficial con token…');
    try {
      ({ gpx, name } = await fetchApiGpx(id, token));
      console.log(`  ✓ API OK${name ? ` → "${name}"` : ''}`);
    } catch (e) {
      console.log(`✗ Error en API: ${e.message}`);
      process.exit(1);
    }
  }

  // — Guardar en _TEMP_ —
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const safeId = String(id).replace(/\D/g, '');
  const filename = path.join(TEMP_DIR, `wikiloc-${safeId}.gpx`);
  fs.writeFileSync(filename, gpx, 'utf8');
  console.log(`  Guardado en ${path.relative(ROOT, filename)}`);

  // — Importar —
  console.log('\nImportando…');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'import-from-temp.js'),
      '--files', path.basename(filename),
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`import-from-temp salió con código ${code}`)));
  });

  console.log('\n✓ Track importado desde Wikiloc');
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
