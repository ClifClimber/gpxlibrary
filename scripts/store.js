'use strict';
// Immutable GPX storage: every original is stored once under the key `{uid}.gpx` and never
// renamed or rewritten afterwards. Name, activity, zone… live only in the database.
// The bytes live in the blob store (blob/: local TracksGps/store or S3); the `file` column keeps
// the historical path `TracksGps/store/{uid}.gpx`, from which the key is derived.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBlob } = require('../blob');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'TracksGps/store';
const STORE_DIR = path.join(ROOT, 'TracksGps', 'store');

const newUid = () => crypto.randomUUID();
const storeRel = uid => `${STORE_REL}/${uid}.gpx`;
const storeKey = uid => `${uid}.gpx`;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const isStored = relFile => typeof relFile === 'string' && relFile.startsWith(STORE_REL + '/');
/** Blob key of a track's `file`, or null for a legacy path outside the store. */
const keyOfFile = relFile => (isStored(relFile) ? relFile.slice(STORE_REL.length + 1) : null);

// Stores a local file under a new uid (refuses to overwrite). The source is removed unless keep=true.
async function putFile(srcAbs, uid, { keep = false, blob = getBlob() } = {}) {
  await blob.put(storeKey(uid), fs.readFileSync(srcAbs));
  if (!keep) fs.unlinkSync(srcAbs);
  return storeRel(uid);
}

/** Bytes of a track's original GPX, or null if it is missing. */
async function readTrackFile(relFile, blob = getBlob()) {
  const key = keyOfFile(relFile);
  if (key) return blob.get(key);
  try { return fs.readFileSync(path.join(ROOT, relFile)); } catch { return null; }   // legacy, pre-store path
}

/** Removes a track's original; true if something was deleted. */
async function deleteTrackFile(relFile, blob = getBlob()) {
  const key = keyOfFile(relFile);
  if (key) return blob.del(key);
  try { fs.unlinkSync(path.join(ROOT, relFile)); return true; } catch { return false; }
}

// GPX text: UTF-8, falling back to Latin-1 for old files with a wrong declaration.
function gpxText(buf) {
  const text = buf.toString('utf8');
  return text.includes('�') ? buf.toString('latin1') : text;
}

// File name shown to the user when downloading: the track name, not the storage key.
function downloadName(name, fallback = 'track') {
  const base = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || fallback;
  return base.toLowerCase().endsWith('.gpx') ? base : base + '.gpx';
}

module.exports = { ROOT, STORE_REL, STORE_DIR, newUid, storeRel, storeKey, keyOfFile, sha256, isStored,
  putFile, readTrackFile, deleteTrackFile, gpxText, downloadName };
