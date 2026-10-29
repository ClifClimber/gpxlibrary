'use strict';
// Copies the photos still on disk (PHOTOS_DIR: track photos, activity images and icons) to the S3
// store under photos/<relative path>. Safe to run again: files already in S3 are skipped.
//   node scripts/photos-to-s3.js [--delete]   (--delete removes each local file once it is in S3)
const fs = require('fs');
const path = require('path');
const { PHOTOS_DIR } = require('../config');
const { createBlob } = require('../blob');

async function main() {
  const del = process.argv.includes('--delete');
  const blob = createBlob();
  if (!fs.existsSync(PHOTOS_DIR)) { console.log(`Sin carpeta de fotos (${PHOTOS_DIR}): nada que copiar`); return; }
  const files = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else files.push(r);
    }
  })(PHOTOS_DIR, '');
  let copied = 0, skipped = 0, failed = 0;
  for (const rel of files) {
    const key = 'photos/' + rel;
    try {
      if (await blob.exists(key)) skipped++;
      else { await blob.put(key, fs.readFileSync(path.join(PHOTOS_DIR, rel))); copied++; }
      if (del) fs.unlinkSync(path.join(PHOTOS_DIR, rel));
    } catch (e) {
      failed++; console.error(`ERROR ${rel}: ${e.message}`);
    }
  }
  console.log(`Fotos: ${files.length} en disco · ${copied} copiadas · ${skipped} ya estaban en S3 · ${failed} con error`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error(e.message); process.exit(1); });
