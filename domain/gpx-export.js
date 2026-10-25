'use strict';
// GPX generation and metadata rewriting on text. No I/O.

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

/** Builds a GPX 1.1 document from [{name, date?, pts:[{lat,lon,ele}]}]. */
function buildGpx(tracks) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="GPX Library" xmlns="http://www.topografix.com/GPX/1/1">',
  ];
  for (const t of tracks) {
    lines.push('  <trk>');
    lines.push(`    <name>${escXml(t.name)}</name>`);
    if (t.date) lines.push(`    <desc>Fecha: ${t.date.slice(0, 10)}</desc>`);
    lines.push('    <trkseg>');
    for (const p of t.pts) {
      const ele = p.ele != null ? `<ele>${p.ele}</ele>` : '';
      lines.push(`      <trkpt lat="${p.lat}" lon="${p.lon}">${ele}</trkpt>`);
    }
    lines.push('    </trkseg>');
    lines.push('  </trk>');
  }
  lines.push('</gpx>');
  return lines.join('\n');
}

/** Metadata fields applied to a stored original when it leaves the app. */
function metaFromTrack(t) {
  const meta = { name: t.name };
  if (t.activity) meta.activity = t.activity;
  if (t.notes) meta.notes = t.notes;
  if (t.url) meta.url = t.url;
  return meta;
}

module.exports = { escXml, applyGpxMetadata, buildGpx, metaFromTrack };
