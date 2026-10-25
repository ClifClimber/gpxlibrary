#!/usr/bin/env node
'use strict';

// Enriquece tracks con tipos de camino y superficie desde OpenStreetMap.
// Delega en la estrategia configurada en osm-settings.json (raíz del proyecto).
// Uso: node scripts/enrich-road-types.js [--ids 1,2,3] [--all] [--force]

const fs   = require('fs');
const path = require('path');
const { openSql } = require('../repo/sql');

const SETTINGS_FILE = path.join(__dirname, '..', 'osm-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return {};
}

async function main() {
  const args   = process.argv.slice(2);
  const force  = args.includes('--force');
  const all    = args.includes('--all');
  const idsIdx = args.indexOf('--ids');
  const idsArg = idsIdx !== -1 ? args[idsIdx + 1] : null;

  const db       = openSql();
  const settings = loadSettings();
  const strategy = settings.strategy || 'per-track';

  let tracks;
  if (idsArg) {
    const ids = idsArg.split(',').map(Number);
    tracks = await db.all(
      `SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon, sierra, province
       FROM tracks WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  } else if (force || all) {
    tracks = await db.all(
      `SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon, sierra, province
       FROM tracks ORDER BY id`);
  } else {
    tracks = await db.all(
      `SELECT id, name, cleaned, sw_lat, sw_lon, ne_lat, ne_lon, sierra, province
       FROM tracks WHERE road_types IS NULL ORDER BY id`);
  }

  console.log(`\nEnriqueciendo ${tracks.length} tracks con datos OSM…`);
  console.log(`Estrategia: ${strategy}`);
  if (!tracks.length) { console.log('Nada que hacer.\n'); await db.close(); return; }

  let mod;
  if (strategy === 'batch-sierra') {
    mod = require('./osm-strategy-batch');
  } else if (strategy === 'local-osm') {
    mod = require('./osm-strategy-local');
  } else {
    mod = require('./osm-strategy-per-track');
  }

  await mod.enrichTracks(tracks, db, settings);
  await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
