'use strict';
// Blob store on the local disk: one file per key inside `dir` (TracksGps/store by default).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function createLocalBlob({ dir }) {
  const abs = key => {
    if (!/^[\w.-]+$/.test(key) || key.startsWith('.')) throw new Error(`Clave de almacén no válida: ${key}`);
    return path.join(dir, key);
  };
  return {
    driver: 'local',
    where: dir,
    async put(key, buf) {
      await fsp.mkdir(dir, { recursive: true });
      try { await fsp.writeFile(abs(key), buf, { flag: 'wx' }); }        // never overwrites an original
      catch (e) { if (e.code === 'EEXIST') throw new Error(`Ya existe en el almacén: ${key}`); throw e; }
    },
    async get(key) {
      try { return await fsp.readFile(abs(key)); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async exists(key) {
      try { await fsp.access(abs(key)); return true; } catch { return false; }
    },
    async del(key) {
      try { await fsp.unlink(abs(key)); return true; }
      catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    },
    async list() {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const out = [];
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        out.push({ key: e.name, size: (await fsp.stat(path.join(dir, e.name))).size });
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async ping() { await fsp.mkdir(dir, { recursive: true }); return true; },
    async close() {},
  };
}

module.exports = { createLocalBlob };
