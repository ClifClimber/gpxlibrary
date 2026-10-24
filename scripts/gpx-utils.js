'use strict';
const fs = require('fs');

function escXml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Devuelve el GPX con name/activity/notes/url aplicados al primer bloque <trk>.
 * Solo cambia los campos presentes en fields; no toca el disco.
 * fields: { name?, activity?, notes?, url? }
 */
function applyGpxMetadata(content, fields) {
  const trkStart = content.indexOf('<trk>');
  if (trkStart === -1) return content;
  const trkSegStart = content.indexOf('<trkseg>', trkStart);
  const headerEnd   = trkSegStart !== -1 ? trkSegStart : content.indexOf('</trk>', trkStart);
  if (headerEnd === -1) return content;

  const TAG_MAP = { name: 'name', activity: 'type', notes: 'desc' };
  let header = content.slice(trkStart, headerEnd);
  const after = content.slice(headerEnd);

  for (const [field, tag] of Object.entries(TAG_MAP)) {
    if (!(field in fields)) continue;
    const val = escXml(fields[field] ?? '');
    const re  = new RegExp(`<${tag}>[^<]*<\/${tag}>`);
    if (re.test(header)) {
      header = header.replace(re, `<${tag}>${val}</${tag}>`);
    } else {
      const insertAt = header.indexOf('>') + 1;
      header = header.slice(0, insertAt) + `\n    <${tag}>${val}</${tag}>` + header.slice(insertAt);
    }
  }

  // URL → <link href="..."/>  (GPX 1.1)
  if ('url' in fields) {
    const url = (fields.url || '').trim();
    header = header.replace(/<link\b[^>]*\/>/g, '').replace(/<link\b[^>]*>[\s\S]*?<\/link>/g, '');
    if (url) {
      const insertAt = header.indexOf('>') + 1;
      header = header.slice(0, insertAt) + `\n    <link href="${escXml(url)}"/>` + header.slice(insertAt);
    }
  }
  return content.slice(0, trkStart) + header + after;
}

/** Versión en disco de applyGpxMetadata. No usar con ficheros del almacén (inmutables). */
function updateGpxMetadata(filePath, fields) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
  const out = applyGpxMetadata(content, fields);
  if (out === content) return false;
  try { fs.writeFileSync(filePath, out, 'utf8'); return true; } catch { return false; }
}

module.exports = { escXml, applyGpxMetadata, updateGpxMetadata };
