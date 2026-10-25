'use strict';
// Copies the original GPX files between the local store and S3, checking each one against the
// sha256 recorded in the database. Never overwrites and never deletes the source.
//   node scripts/blob-copy.js --to s3|local     → copy whatever is missing, then verify
//   node scripts/blob-copy.js --verify [--on s3|local]   → only check (default: the active store)
// Exit code: 0 ok · 1 error · 2 some file is missing or differs.
const { createBlob } = require('../blob');
const { openSql } = require('../repo/sql');
const { keyOfFile, sha256 } = require('./store');
const config = require('../config');

const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const TO = arg('--to');
const VERIFY_ONLY = args.includes('--verify');
const ON = arg('--on') || config.STORAGE_DRIVER;
if (!VERIFY_ONLY && !['s3', 'local'].includes(TO)) {
  console.log('Uso: node scripts/blob-copy.js --to s3|local | --verify [--on s3|local]');
  process.exit(1);
}

// Runs fn over items with a few requests in flight
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function tracksWithKeys() {
  const db = openSql();
  const rows = await db.all('SELECT id, name, file, sha256 FROM tracks ORDER BY id');
  await db.close();
  const legacy = rows.filter(r => !keyOfFile(r.file));
  if (legacy.length) console.log(`⚠ ${legacy.length} rutas fuera del almacén (ejecuta migrate-store): ${legacy.slice(0, 5).map(r => r.id).join(', ')}…`);
  return rows.filter(r => keyOfFile(r.file)).map(r => ({ ...r, key: keyOfFile(r.file) }));
}

async function verify(store, tracks) {
  const bad = [];
  let done = 0;
  await pool(tracks, 8, async t => {
    const buf = await store.get(t.key);
    if (!buf) bad.push(`id=${t.id} falta ${t.key}`);
    else if (t.sha256 && sha256(buf) !== t.sha256) bad.push(`id=${t.id} ${t.key} no coincide con su huella`);
    if (++done % 100 === 0) console.log(`… ${done} de ${tracks.length} comprobados`);
  });
  return bad;
}

async function main() {
  const tracks = await tracksWithKeys();
  if (VERIFY_ONLY) {
    const store = createBlob({ driver: ON });
    console.log(`Comprobando ${tracks.length} ficheros en ${store.driver} (${store.where})`);
    const bad = await verify(store, tracks);
    await store.close();
    bad.forEach(b => console.log('  ✗ ' + b));
    console.log(bad.length ? `✗ ${bad.length} ficheros con problemas` : `✓ Los ${tracks.length} ficheros están y coinciden con su huella`);
    return bad.length ? 2 : 0;
  }

  const from = createBlob({ driver: TO === 's3' ? 'local' : 's3' });
  const to = createBlob({ driver: TO });
  await from.ping();
  await to.ping();
  console.log(`Origen : ${from.driver} (${from.where})`);
  console.log(`Destino: ${to.driver} (${to.where})`);

  const already = new Set((await to.list()).map(o => o.key));
  let copied = 0, present = 0, done = 0;
  const errors = [];
  await pool(tracks, 8, async t => {
    try {
      if (already.has(t.key)) { present++; return; }
      const buf = await from.get(t.key);
      if (!buf) throw new Error(`no está en el origen`);
      if (t.sha256 && sha256(buf) !== t.sha256) throw new Error('el original no coincide con su huella; no se copia');
      await to.put(t.key, buf);
      copied++;
    } catch (e) { errors.push(`id=${t.id} ${t.key}: ${e.message}`); }
    finally { if (++done % 50 === 0) console.log(`… ${done} de ${tracks.length}`); }
  });
  console.log(`Copiados: ${copied} · Ya estaban: ${present} · Errores: ${errors.length}`);
  errors.forEach(e => console.log('  ✗ ' + e));

  const referenced = new Set(tracks.map(t => t.key));
  const orphans = (await from.list()).filter(o => !referenced.has(o.key));
  if (orphans.length) console.log(`ℹ ${orphans.length} ficheros del origen sin ruta en la BD (no se copian): ${orphans.slice(0, 3).map(o => o.key).join(', ')}…`);

  console.log('\nComprobando el destino…');
  const bad = await verify(to, tracks);
  bad.forEach(b => console.log('  ✗ ' + b));
  await from.close();
  await to.close();
  if (bad.length || errors.length) { console.log('✗ El destino no está completo'); return 2; }
  console.log(`✓ Los ${tracks.length} ficheros están en ${TO} y coinciden con su huella`);
  return 0;
}

main().then(code => process.exit(code), e => { console.error('✗ ' + e.message); process.exit(1); });
