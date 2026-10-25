'use strict';
// Writes a browsable copy of the library as <dest>/<Actividad>/<Sierra>/<Nombre>.gpx.
// The stored originals are only read; each copy carries the current name/activity/notes/url.
//   node scripts/export-folders.js --dest "D:\Rutas" [--ids 1,2,3]
const fs = require('fs');
const path = require('path');
const { openSql } = require('../repo/sql');
const { ROOT } = require('./store');
const { applyGpxMetadata, metaFromTrack } = require('../domain');

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const destArg = arg('--dest');
const ids = (arg('--ids') || '').split(',').map(Number).filter(Boolean);

if (!destArg) { console.log('✗ Falta la carpeta de destino'); process.exit(1); }
const dest = path.resolve(destArg);
const tracksDir = path.join(ROOT, 'TracksGps');
const rel = path.relative(tracksDir, dest);
if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
  console.log('✗ El destino no puede estar dentro de TracksGps (ahí vive el almacén de originales)');
  process.exit(1);
}

const safe = s => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
(async () => {
const db = openSql();
const rows = ids.length
  ? await db.all(`SELECT id,name,file,activity,sierra,zone,notes,url FROM tracks WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids)
  : await db.all(`SELECT id,name,file,activity,sierra,zone,notes,url FROM tracks ORDER BY activity ${db.BIN}, sierra ${db.BIN}, name ${db.BIN}, id`);
await db.close();

console.log(`Destino: ${dest}`);
console.log(`Exportando ${rows.length} track(s)…\n`);
fs.mkdirSync(dest, { recursive: true });

let written = 0, missing = 0, errors = 0, renamed = 0;
const used = new Set();
rows.forEach((t, i) => {
  try {
    const src = path.join(ROOT, t.file);
    if (!fs.existsSync(src)) { console.log(`  ⚠ Sin fichero: «${t.name}» (id=${t.id})`); missing++; return; }
    const dir = path.join(dest, safe(t.activity) || 'Sin actividad', safe(t.sierra || t.zone) || 'General');
    const stem = safe(t.name) || `track-${t.id}`;
    let file = path.join(dir, stem + '.gpx');
    if (used.has(file.toLowerCase()) || fs.existsSync(file)) { file = path.join(dir, `${stem} (${t.id}).gpx`); renamed++; }
    used.add(file.toLowerCase());

    const buf = fs.readFileSync(src);
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) text = buf.toString('latin1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, applyGpxMetadata(text, metaFromTrack(t)), 'utf8');
    written++;
    if ((i + 1) % 25 === 0) console.log(`Exportados: ${i + 1} de ${rows.length}`);
  } catch (e) { console.log(`  ✗ «${t.name}» (id=${t.id}): ${e.message}`); errors++; }
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`✓ Exportación completada en ${dest}`);
console.log(`  Ficheros escritos   : ${written}`);
if (renamed) console.log(`  Con sufijo (id)     : ${renamed}  (nombre repetido o ya existente en el destino)`);
if (missing) console.log(`  Sin fichero origen  : ${missing}`);
console.log(`  Errores             : ${errors}`);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
