#!/usr/bin/env node
'use strict';

// Reescribe los atributos (name, activity, notes, url) de todos los
// tracks de la BD en sus correspondientes archivos GPX.
// Uso: node scripts/write-gpx-attrs.js [--ids 1,2,3]

const path = require('path');
const fs   = require('fs');
const { openDb }           = require('./db');
const { updateGpxMetadata } = require('./gpx-utils');

const ROOT = path.join(__dirname, '..');

const idsIdx = process.argv.indexOf('--ids');
const FILTER_IDS = idsIdx !== -1
  ? new Set(process.argv[idsIdx + 1].split(',').map(Number))
  : null;

const db = openDb();
let tracks = db.prepare('SELECT id, name, file, activity, notes, url FROM tracks ORDER BY id').all();
if (FILTER_IDS) tracks = tracks.filter(t => FILTER_IDS.has(t.id));

if (!tracks.length) { console.log('✓ Sin tracks que procesar.'); process.exit(0); }

console.log(`\nEscribiendo atributos en ${tracks.length} archivos GPX...\n`);

let ok = 0, fail = 0, missing = 0;

for (const t of tracks) {
  const filePath = path.join(ROOT, t.file);
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠ No encontrado: ${t.file}`);
    missing++;
    continue;
  }
  const fields = { name: t.name };
  if (t.activity != null) fields.activity = t.activity;
  if (t.notes    != null) fields.notes    = t.notes;
  if (t.url      != null) fields.url      = t.url;

  if (updateGpxMetadata(filePath, fields)) {
    ok++;
    console.log(`  ✓ [${t.id}] ${t.name}`);
  } else {
    fail++;
    console.log(`  ✗ [${t.id}] ${t.name}  (no se pudo escribir)`);
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`✓ ${ok} actualizados · ✗ ${fail} errores · ${missing} no encontrados`);
