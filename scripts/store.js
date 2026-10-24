'use strict';
// Immutable GPX storage: every original file lives at TracksGps/store/{uid}.gpx and is never
// renamed or rewritten afterwards. Name, activity, zone… live only in the database.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'TracksGps/store';
const STORE_DIR = path.join(ROOT, 'TracksGps', 'store');

const newUid = () => crypto.randomUUID();
const storeRel = uid => `${STORE_REL}/${uid}.gpx`;
const storeAbs = uid => path.join(STORE_DIR, `${uid}.gpx`);
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const isStored = relFile => typeof relFile === 'string' && relFile.startsWith(STORE_REL + '/');

// Moves (or copies, with keep=true) a file into the store. Refuses to overwrite.
function putFile(srcAbs, uid, { keep = false } = {}) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const dest = storeAbs(uid);
  if (fs.existsSync(dest)) throw new Error(`store collision: ${uid}`);
  if (keep) fs.copyFileSync(srcAbs, dest);
  else {
    try { fs.renameSync(srcAbs, dest); }
    catch { fs.copyFileSync(srcAbs, dest); fs.unlinkSync(srcAbs); }
  }
  return storeRel(uid);
}

// File name shown to the user when downloading: the track name, not the storage key.
function downloadName(name, fallback = 'track') {
  const base = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || fallback;
  return base.toLowerCase().endsWith('.gpx') ? base : base + '.gpx';
}

module.exports = { ROOT, STORE_REL, STORE_DIR, newUid, storeRel, storeAbs, sha256, isStored, putFile, downloadName };
