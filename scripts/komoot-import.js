#!/usr/bin/env node
'use strict';
// Descarga un track de Komoot y lo importa en la BD.
// Uso: node scripts/komoot-import.js <url-o-id>
// Solo funciona con tours públicos (no requiere auth).

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, 'TracksGps', '_TEMP_');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseId(str) {
  str = str.trim();
  if (/^\d+$/.test(str)) return str;
  // https://www.komoot.com/tour/12345678 o /de/tour/...
  const m = str.match(/\/tour\/(\d+)/);
  return m ? m[1] : null;
}

function extractGpxName(gpx) {
  const m = gpx.match(/<name>([^<]{1,120})<\/name>/);
  return m ? m[1].trim() : null;
}

function isValidGpx(text) {
  return typeof text === 'string' && text.includes('<gpx') && (text.includes('<trkpt') || text.includes('<wpt'));
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.log('⚠ Falta la URL o ID de Komoot'); process.exit(1); }

  const id = parseId(arg);
  if (!id) { console.log(`⚠ No se pudo extraer el ID de Komoot de: ${arg}`); process.exit(1); }

  console.log(`Descargando track Komoot #${id}…`);

  let gpx = null;
  let name = null;

  try {
    const resp = await fetch(`https://www.komoot.com/api/v007/tours/${id}.gpx`, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/gpx+xml,text/xml,*/*',
        'Referer': 'https://www.komoot.com/',
      },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!isValidGpx(text)) throw new Error('La respuesta no es un GPX válido');
    gpx  = text;
    name = extractGpxName(gpx);
    console.log(`  ✓ Descarga OK${name ? ` → "${name}"` : ''}`);
  } catch (e) {
    console.log(`✗ No se pudo descargar el track: ${e.message}`);
    console.log('  Asegúrate de que el tour es público en Komoot.');
    process.exit(1);
  }

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const filename = path.join(TEMP_DIR, `komoot-${id}.gpx`);
  fs.writeFileSync(filename, gpx, 'utf8');
  console.log(`  Guardado en ${path.relative(ROOT, filename)}`);

  console.log('\nImportando…');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'import-from-temp.js'),
      '--files', path.basename(filename),
      ...(process.argv.includes('--owner') ? ['--owner', process.argv[process.argv.indexOf('--owner') + 1]] : []),
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`import-from-temp salió con código ${code}`)));
  });

  console.log('\n✓ Track importado desde Komoot');
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
