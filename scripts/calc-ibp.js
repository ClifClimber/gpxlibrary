#!/usr/bin/env node
'use strict';

// Calcula el IBP Index llamando a la API oficial de ibpindex.com
//
// Uso:
//   node scripts/calc-ibp.js              → todos los tracks sin IBP
//   node scripts/calc-ibp.js --force      → recalcula todos
//   node scripts/calc-ibp.js --ids 1,2,3  → solo esos IDs
//
// API key: guárdala en el fichero "ibp.key" (raíz del proyecto)
// o en la variable de entorno IBP_KEY.
// Consigue tu clave gratuita en https://www.ibpindex.com

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { openSql } = require('../repo/sql');
const { readTrackFile } = require('./store');

const ROOT     = path.join(__dirname, '..');
const KEY_FILE = path.join(ROOT, 'ibp.key');

function getApiKey() {
  if (process.env.IBP_KEY) return process.env.IBP_KEY.trim();
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  return null;
}

function callIBPApi(apiKey, gpxContent, filename) {
  return new Promise((resolve, reject) => {
    const boundary   = '----IBPBoundary' + Date.now().toString(16);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\n${apiKey}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/gpx+xml\r\n\r\n`),
      gpxContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = https.request({
      hostname: 'www.ibpindex.com',
      path:     '/api/',
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent':     'GPXLibrary/1.0',
      },
      timeout: 30000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Respuesta no válida de la API: ' + data.slice(0, 300))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout al llamar a IBP API (30s)')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Parse args ───────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const force    = args.includes('--force');
const idsIdx   = args.indexOf('--ids');
const idsArg   = idsIdx !== -1 ? args[idsIdx + 1] : null;
const filterIds = idsArg ? idsArg.split(',').map(Number).filter(n => n > 0) : null;

const apiKey = getApiKey();
if (!apiKey) {
  console.error('\n⚠ No se encontró la API key del IBP Index.');
  console.error('  1. Regístrate gratis en https://www.ibpindex.com para obtener tu clave.');
  console.error('  2. Guarda la clave en el fichero "ibp.key" (raíz del proyecto),');
  console.error('     o en la variable de entorno IBP_KEY.');
  process.exit(1);
}

let ok = 0, errCount = 0;

(async () => {
const db = openSql();

let query = 'SELECT id, name, file, activity FROM tracks WHERE file IS NOT NULL';
if (!force) query += ' AND ibp_bicycle IS NULL';
if (filterIds) query += ` AND id IN (${filterIds.map(() => '?').join(',')})`;
query += ' ORDER BY date DESC, name ASC';

const tracks = await db.all(query, filterIds || []);

if (!tracks.length) {
  console.log(force
    ? '\nNo hay tracks con fichero GPX.\n'
    : '\n✓ Todos los tracks ya tienen IBP calculado. Usa --force para recalcular.\n'
  );
  await db.close();
  process.exit(0);
}

console.log(`\nCalculando IBP para ${tracks.length} track(s)...\n`);

  for (const t of tracks) {
    const gpxContent = await readTrackFile(t.file);
    if (!gpxContent) {
      console.log(`⚠ [${t.id}] Fichero no encontrado: ${t.file}`);
      errCount++;
      continue;
    }

    try {
      process.stdout.write(`  [${t.id}] ${t.name}... `);
      const result = await callIBPApi(apiKey, gpxContent, path.basename(t.file));

      if (result.error) {
        const msg = String(result.error).toLowerCase();
        if (msg.includes('key') || msg.includes('clave')) {
          console.log('');
          console.error(`✗ Error de API key: ${result.error}`);
          console.error('  Verifica tu clave en https://www.ibpindex.com');
          process.exit(1);
        }
        console.log(`⚠ ${result.error}`);
        errCount++;
        continue;
      }

      // La API devuelve los datos bajo "bicycle", "hiking", "running"
      // o a veces "byc", "hkg", "rng" según versión
      const ibpBicycle = result.bicycle?.ibp != null ? parseFloat(result.bicycle.ibp) : null;
      const ibpHiking  = result.hiking?.ibp  != null ? parseFloat(result.hiking.ibp)  : null;
      const ibpRunning = result.running?.ibp != null ? parseFloat(result.running.ibp) : null;

      if (ibpBicycle == null && ibpHiking == null && ibpRunning == null) {
        console.log('sin datos — respuesta:');
        console.log(JSON.stringify({ error: result.error, bicycle: result.bicycle?.ibp, hiking: result.hiking?.ibp, running: result.running?.ibp }));
        errCount++;
        continue;
      }

      await db.run('UPDATE tracks SET ibp_bicycle=?, ibp_hiking=?, ibp_running=? WHERE id=?', [ibpBicycle, ibpHiking, ibpRunning, t.id]);

      const CYCLING = ['Mtb','Gravel','Bikepacking','Ciclismo de carretera'];
      const RUNNING = ['Trail Running','Running'];
      let mainVal, mainTag;
      if (CYCLING.includes(t.activity)) { mainVal = ibpBicycle; mainTag = 'BYC'; }
      else if (RUNNING.includes(t.activity)) { mainVal = ibpRunning; mainTag = 'RNG'; }
      else { mainVal = ibpHiking; mainTag = 'HKG'; }
      console.log(mainVal != null ? `${mainTag} ${mainVal}` : '(sin valor para esta modalidad)');
      ok++;

      // Pausa entre peticiones para no sobrecargar la API
      if (ok + errCount < tracks.length) await new Promise(r => setTimeout(r, 600));
    } catch(e) {
      console.log('');
      console.error(`  ✗ Error: ${e.message}`);
      errCount++;
    }
  }

  console.log(`\n✓ Procesados: ${ok} ok, ${errCount} errores.\n`);
  await db.close();
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
