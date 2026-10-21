'use strict';
// Método 3: OSM local con osmium-tool + PBF de España.
// Requiere: osmium-tool instalado + datos descargados con osm-download.js.

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fetchTrackPts, applyWaysToTrack } = require('./osm-shared');

const MAX_PTS = 1500;
const TMP_DIR = path.join(__dirname, '..', 'data', 'osm');

async function enrichTracks(tracks, db, opts = {}) {
  const pbfPath = opts.localPbfPath
    ? path.resolve(opts.localPbfPath)
    : path.join(__dirname, '..', 'data', 'osm', 'spain-highways.osm.pbf');

  if (!fs.existsSync(pbfPath)) {
    console.log(`✗ Archivo PBF no encontrado: ${pbfPath}`);
    console.log('  Descarga los datos OSM desde Admin → Estrategia OSM → Descargar datos.');
    process.exit(1);
  }

  try {
    execFileSync('osmium', ['--version'], { stdio: 'ignore' });
  } catch {
    console.log('✗ osmium-tool no está instalado o no está en el PATH.');
    console.log('  Instala osmium-tool: https://osmcode.org/osmium-tool/');
    process.exit(1);
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });

  let ok = 0, fail = 0;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    console.log(`[${i+1}/${tracks.length}] ${t.name}`);

    if (!t.sw_lat) { console.log('  ⚠ Sin bbox, saltando'); fail++; continue; }

    const buf  = 0.008;
    const bbox = `${t.sw_lon - buf},${t.sw_lat - buf},${t.ne_lon + buf},${t.ne_lat + buf}`;
    const tmp  = path.join(TMP_DIR, `tmp-${t.id}.geojson`);

    let ways;
    try {
      execFileSync('osmium', [
        'export',
        '--bbox', bbox,
        '--output-format', 'geojson',
        '--overwrite',
        '-o', tmp,
        pbfPath,
      ], { timeout: 30000, stdio: ['ignore', 'ignore', 'pipe'] });

      const geojson = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      fs.unlinkSync(tmp);

      ways = (geojson.features || [])
        .filter(f => f.properties?.highway && f.geometry?.type === 'LineString')
        .map(f => ({
          type:     'way',
          tags:     f.properties,
          geometry: f.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
        }));

      console.log(`  OSM: ${ways.length} caminos`);
    } catch (err) {
      console.log(`  ✗ osmium: ${err.message}`);
      if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch {} }
      fail++;
      continue;
    }

    const pts = fetchTrackPts(t, db, MAX_PTS);
    if (pts.length < 2) { console.log('  ⚠ Sin puntos'); fail++; continue; }

    applyWaysToTrack(t, pts, ways, db);
    ok++;
  }

  console.log(`\n✓ Completado: ${ok} ok, ${fail} fallidos\n`);
}

module.exports = { enrichTracks };
