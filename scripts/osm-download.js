#!/usr/bin/env node
'use strict';
// Descarga datos OSM de España y extrae las vías (highway) con osmium-tool.
// Uso: node scripts/osm-download.js

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const OSM_DIR = path.join(ROOT, 'data', 'osm');
const RAW_PBF = path.join(OSM_DIR, 'spain-latest.osm.pbf');
const HW_PBF  = path.join(OSM_DIR, 'spain-highways.osm.pbf');
const SPAIN_URL = 'https://download.geofabrik.de/europe/spain-latest.osm.pbf';

function log(text)   { console.log(text); }
function logOk(text) { console.log('✓ ' + text); }
function logErr(text){ console.error('✗ ' + text); }

function fmtMB(bytes) { return (bytes / 1048576).toFixed(0) + ' MB'; }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    log(`Descargando ${path.basename(dest)}…`);
    const file = fs.createWriteStream(dest);
    let received = 0, total = 0, lastPct = -1;

    function doGet(u) {
      const lib = u.startsWith('https') ? https : http;
      lib.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        total = parseInt(res.headers['content-length'] || '0');
        if (total) log(`  Tamaño total: ${fmtMB(total)}`);

        res.on('data', chunk => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0) {
            const pct = Math.floor(received / total * 100);
            if (pct >= lastPct + 5) {
              lastPct = pct;
              log(`  ${pct}% — ${fmtMB(received)} / ${fmtMB(total)}`);
            }
          }
        });
        res.on('end', () => { file.end(); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

async function main() {
  fs.mkdirSync(OSM_DIR, { recursive: true });

  // Check osmium
  try {
    execFileSync('osmium', ['--version'], { stdio: 'pipe' });
    logOk('osmium-tool disponible');
  } catch {
    logErr('osmium-tool no está instalado. Instálalo desde: https://osmcode.org/osmium-tool/');
    process.exit(1);
  }

  log(`Fuente: ${SPAIN_URL}`);
  log(`Destino: ${OSM_DIR}`);

  // Download
  try {
    await download(SPAIN_URL, RAW_PBF);
    logOk(`Descarga completa: ${fmtMB(fs.statSync(RAW_PBF).size)}`);
  } catch (err) {
    logErr('Error al descargar: ' + err.message);
    try { if (fs.existsSync(RAW_PBF)) fs.unlinkSync(RAW_PBF); } catch {}
    process.exit(1);
  }

  // Filter highways with osmium
  log('\nFiltrando vías highway con osmium…');
  try {
    execFileSync('osmium', ['tags-filter', RAW_PBF, 'w/highway', '-o', HW_PBF, '--overwrite'], {
      timeout: 600000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logOk(`Filtrado completo: ${fmtMB(fs.statSync(HW_PBF).size)}`);
  } catch (err) {
    logErr('Error al filtrar: ' + err.message);
    process.exit(1);
  }

  // Remove full PBF
  log('Eliminando descarga completa…');
  try { fs.unlinkSync(RAW_PBF); } catch {}
  logOk(`Listo. Datos OSM locales disponibles en ${HW_PBF}`);
  process.exit(0);
}

main().catch(e => { logErr(e.message); process.exit(1); });
