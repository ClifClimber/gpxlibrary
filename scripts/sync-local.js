'use strict';
// Syncs GPX files from S3 to a local mirror folder (for offline access / backup).
// The folder mirrors the S3 key structure: {uid}.gpx files flat inside the configured directory.
// New files are downloaded; deleted or existing files are left untouched.
//
// Usage: node scripts/sync-local.js [--dir /path/to/folder] [--clean]
//   --dir   Override the sync folder (default: LOCAL_SYNC_DIR in .env or TracksGps/local)
//   --clean Remove local files whose key no longer exists in S3
const path = require('path');
const fs   = require('fs');
const { getBlob } = require('../blob');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg  = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CLEAN = args.includes('--clean');

// Resolve the sync directory (argument > env var > default)
function syncDir() {
  const from = arg('--dir') || process.env.LOCAL_SYNC_DIR;
  if (from) return path.isAbsolute(from) ? from : path.resolve(ROOT, from);
  return path.join(ROOT, 'TracksGps', 'local');
}

(async () => {
  const dir = syncDir();
  fs.mkdirSync(dir, { recursive: true });

  const blob = getBlob();
  const remote = await blob.list();                       // [{ key, size }]
  const remoteKeys = new Set(remote.map(f => f.key));

  const existing = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.gpx')));
  const toDownload = remote.filter(f => !existing.has(f.key));
  const toRemove   = CLEAN ? [...existing].filter(k => !remoteKeys.has(k)) : [];

  console.log(`S3: ${remote.length} ficheros  |  local: ${existing.size}  |  a descargar: ${toDownload.length}${CLEAN ? `  |  a eliminar: ${toRemove.length}` : ''}`);

  let copied = 0;
  for (const { key } of toDownload) {
    const data = await blob.get(key);
    if (!data) { console.warn(`⚠ No se pudo leer ${key}`); continue; }
    fs.writeFileSync(path.join(dir, key), data);
    if (++copied % 20 === 0 || copied === toDownload.length)
      console.log(`Copiados: ${copied} / ${toDownload.length}`);
  }

  for (const key of toRemove) {
    fs.unlinkSync(path.join(dir, key));
  }

  console.log(`✓ ${copied} copiados${CLEAN && toRemove.length ? `, ${toRemove.length} eliminados` : ''}  →  ${dir}`);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
