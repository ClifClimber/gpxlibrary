'use strict';
// Moves every track's GPX into the immutable store (TracksGps/store/{uid}.gpx).
//   node scripts/migrate-store.js --dry-run          → report only
//   node scripts/migrate-store.js                    → migrate, writes data/migrations/store-*.json
//   node scripts/migrate-store.js --revert <file>    → move files back using that manifest
const fs = require('fs');
const path = require('path');
const { openSql } = require('../repo/sql');
const { ROOT, newUid, storeKey, sha256, isStored, putFile, readTrackFile } = require('./store');
const { getBlob } = require('../blob');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const revertIdx = args.indexOf('--revert');
const MIG_DIR = path.join(ROOT, 'data', 'migrations');
const abs = rel => path.join(ROOT, rel.replace(/\//g, path.sep));

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'store' || e.name.startsWith('_')) continue;
    const full = path.join(dir, e.name);
    removed += removeEmptyDirs(full);
    if (!fs.readdirSync(full).length) { fs.rmdirSync(full); removed++; }
  }
  return removed;
}

async function revert(manifestPath) {
  if (getBlob().driver !== 'local') throw new Error('--revert solo funciona con el almacén local (STORAGE_DRIVER=local)');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const db = openSql();
  let ok = 0, fail = 0;
  for (const e of m.entries) {
    try {
      const src = abs(e.to), dest = abs(e.from);
      if (!fs.existsSync(src)) throw new Error('no está en el almacén');
      if (fs.existsSync(dest)) throw new Error('ya existe el destino');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      await db.run('UPDATE tracks SET file=? WHERE id=?', [e.from, e.id]);
      ok++;
    } catch (err) { console.log(`  ✗ id=${e.id} ${e.from}: ${err.message}`); fail++; }
  }
  console.log(`Revertidos: ${ok}  ·  Errores: ${fail}`);
  await db.close();
}

async function migrate() {
  const db = openSql();
  const tracks = await db.all('SELECT id, name, file, uid, sha256 FROM tracks ORDER BY id');
  const UPD = 'UPDATE tracks SET file=?, uid=?, sha256=? WHERE id=?';
  const entries = [], missing = [], hashes = new Map();
  let moved = 0, hashed = 0;

  console.log(`${DRY ? '[SIMULACIÓN] ' : ''}Tracks en la BD: ${tracks.length}`);
  for (const t of tracks) {
    const src = abs(t.file);
    const buf = await readTrackFile(t.file);
    if (!buf) { missing.push(t); continue; }
    const hash = sha256(buf);
    if (hashes.has(hash)) console.log(`  ⚠ id=${t.id} tiene el mismo contenido que id=${hashes.get(hash)}`);
    else hashes.set(hash, t.id);

    if (isStored(t.file)) {
      if (!t.sha256 || !t.uid) { if (!DRY) await db.run(UPD, [t.file, t.uid || path.basename(t.file, '.gpx'), hash, t.id]); hashed++; }
      continue;
    }
    const uid = t.uid || newUid();
    if (DRY) { moved++; continue; }
    let rel;
    try { rel = await putFile(src, uid, { keep: true }); }
    catch (err) { console.log(`  ✗ id=${t.id} ${t.file}: ${err.message}`); continue; }
    try {
      await db.tx(t2 => t2.run(UPD, [rel, uid, hash, t.id]));
    } catch (err) {
      await getBlob().del(storeKey(uid)).catch(() => {});   // undo the copy if the DB update failed
      console.log(`  ✗ id=${t.id} BD: ${err.message}`);
      continue;
    }
    fs.unlinkSync(src);
    entries.push({ id: t.id, uid, from: t.file, to: rel });
    moved++;
  }

  if (!DRY && entries.length) {
    fs.mkdirSync(MIG_DIR, { recursive: true });
    const mf = path.join(MIG_DIR, `store-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    fs.writeFileSync(mf, JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 1));
    console.log(`Manifiesto: ${path.relative(ROOT, mf)}  (revertir: node scripts/migrate-store.js --revert "${path.relative(ROOT, mf)}")`);
  }
  const emptied = DRY ? 0 : removeEmptyDirs(path.join(ROOT, 'TracksGps'));

  console.log(`${DRY ? 'Se moverían' : 'Movidos'}: ${moved}  ·  Huella añadida: ${hashed}  ·  Sin fichero en disco: ${missing.length}  ·  Carpetas vacías borradas: ${emptied}`);
  missing.forEach(t => console.log(`  ⚠ Sin fichero: id=${t.id} «${t.name}» → ${t.file}`));
  if (!DRY) { const b = getBlob(); console.log(`Almacén (${b.driver}): ${b.where} (${(await b.list()).length} ficheros)`); }
  await db.close();
}

if (revertIdx >= 0) {
  const mf = args[revertIdx + 1];
  if (!mf) { console.error('Uso: --revert <manifiesto.json>'); process.exit(1); }
  revert(path.resolve(mf)).catch(e => { console.error('✗ ' + e.message); process.exit(1); });
} else migrate().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
