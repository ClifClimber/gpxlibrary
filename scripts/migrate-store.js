'use strict';
// Moves every track's GPX into the immutable store (TracksGps/store/{uid}.gpx).
//   node scripts/migrate-store.js --dry-run          → report only
//   node scripts/migrate-store.js                    → migrate, writes data/migrations/store-*.json
//   node scripts/migrate-store.js --revert <file>    → move files back using that manifest
const fs = require('fs');
const path = require('path');
const { openDb, withTransaction } = require('./db');
const { ROOT, STORE_DIR, newUid, storeAbs, sha256, isStored, putFile } = require('./store');

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

function revert(manifestPath) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const db = openDb();
  const upd = db.prepare('UPDATE tracks SET file=? WHERE id=?');
  let ok = 0, fail = 0;
  for (const e of m.entries) {
    try {
      const src = abs(e.to), dest = abs(e.from);
      if (!fs.existsSync(src)) throw new Error('no está en el almacén');
      if (fs.existsSync(dest)) throw new Error('ya existe el destino');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      upd.run(e.from, e.id);
      ok++;
    } catch (err) { console.log(`  ✗ id=${e.id} ${e.from}: ${err.message}`); fail++; }
  }
  console.log(`Revertidos: ${ok}  ·  Errores: ${fail}`);
}

function migrate() {
  const db = openDb();
  const tracks = db.prepare('SELECT id, name, file, uid, sha256 FROM tracks ORDER BY id').all();
  const upd = db.prepare('UPDATE tracks SET file=?, uid=?, sha256=? WHERE id=?');
  const entries = [], missing = [], hashes = new Map();
  let moved = 0, hashed = 0;

  console.log(`${DRY ? '[SIMULACIÓN] ' : ''}Tracks en la BD: ${tracks.length}`);
  for (const t of tracks) {
    const src = abs(t.file);
    if (!fs.existsSync(src)) { missing.push(t); continue; }
    const buf = fs.readFileSync(src);
    const hash = sha256(buf);
    if (hashes.has(hash)) console.log(`  ⚠ id=${t.id} tiene el mismo contenido que id=${hashes.get(hash)}`);
    else hashes.set(hash, t.id);

    if (isStored(t.file)) {
      if (!t.sha256 || !t.uid) { if (!DRY) upd.run(t.file, t.uid || path.basename(t.file, '.gpx'), hash, t.id); hashed++; }
      continue;
    }
    const uid = t.uid || newUid();
    if (DRY) { moved++; continue; }
    let rel;
    try { rel = putFile(src, uid); }
    catch (err) { console.log(`  ✗ id=${t.id} ${t.file}: ${err.message}`); continue; }
    try {
      withTransaction(() => upd.run(rel, uid, hash, t.id));
    } catch (err) {
      fs.renameSync(storeAbs(uid), src);           // put it back if the DB update failed
      console.log(`  ✗ id=${t.id} BD: ${err.message}`);
      continue;
    }
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
  if (!DRY) console.log(`Almacén: ${path.relative(ROOT, STORE_DIR)} (${fs.readdirSync(STORE_DIR).length} ficheros)`);
}

if (revertIdx >= 0) {
  const mf = args[revertIdx + 1];
  if (!mf) { console.error('Uso: --revert <manifiesto.json>'); process.exit(1); }
  revert(path.resolve(mf));
} else migrate();
