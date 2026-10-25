'use strict';
// GPX text → plain data. No I/O: the caller reads the file and passes its text.

const unesc = s => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

const baseName = f => String(f || '').split(/[\\/]/).pop();

/**
 * @param {string} content  GPX text
 * @param {{fileName?: string}} [opts]  used as fallback for the name and the date (YYYY-MM-DD prefix)
 * @returns {{name, date, url, points: {lat,lon,ele,time}[], waypoints: object[]}}
 *          points[].time is epoch ms or null.
 */
function parseGpx(content, { fileName = '' } = {}) {
  let name = baseName(fileName).replace(/\.gpx$/i, '');
  const trkName = content.match(/<trk\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
  if (trkName) name = unesc(trkName[1]);
  else {
    const mn = content.match(/<metadata\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/);
    if (mn) name = unesc(mn[1]).replace(/^wikiloc\s*-\s*/i, '').trim();
  }

  let url = null;
  const metaLink = content.match(/<metadata\b[^>]*>[\s\S]*?<link\s[^>]*href="([^"]+)"/);
  if (metaLink) url = metaLink[1].trim();
  if (!url) {
    const trkLink = content.match(/<trk\b[^>]*>[\s\S]*?<link\s[^>]*href="([^"]+)"/);
    if (trkLink) url = trkLink[1].trim();
  }

  let date = null;
  const mt = content.match(/<metadata\b[^>]*>[\s\S]*?<time>([^<]+)<\/time>/);
  if (mt) date = mt[1].trim().substring(0, 10);
  if (!date) {
    const pt = content.match(/<trkpt\b[^>]*>[\s\S]*?<time>([^<]+)<\/time>/);
    if (pt) date = pt[1].trim().substring(0, 10);
  }
  if (!date) {
    const fn = baseName(fileName).match(/^(\d{4}-\d{2}-\d{2})/);
    if (fn) date = fn[1];
  }

  const points = [];
  let pos = 0;
  while (true) {
    const ts = content.indexOf('<trkpt', pos);
    if (ts === -1) break;
    const te = content.indexOf('>', ts);
    if (te === -1) break;
    const ce = content.indexOf('</trkpt>', te);
    const tag = content.substring(ts, te + 1);
    const body = ce !== -1 ? content.substring(te + 1, ce) : '';
    const latM = tag.match(/\blat="([^"]+)"/);
    const lonM = tag.match(/\blon="([^"]+)"/);
    const eleM = body.match(/<ele>([^<]+)<\/ele>/);
    const timeM = body.match(/<time>([^<]+)<\/time>/);
    if (latM && lonM) {
      const lat = parseFloat(latM[1]), lon = parseFloat(lonM[1]);
      if (!isNaN(lat) && !isNaN(lon)) {
        const t = timeM ? new Date(timeM[1].trim()).getTime() : NaN;
        points.push({ lat, lon, ele: eleM ? parseFloat(eleM[1]) : null, time: isNaN(t) ? null : t });
      }
    }
    pos = ce !== -1 ? ce + 8 : te + 1;
  }

  const waypoints = [];
  let wpos = 0;
  while (true) {
    const ws = content.indexOf('<wpt', wpos);
    if (ws === -1) break;
    const wte = content.indexOf('>', ws);
    if (wte === -1) break;
    const wce = content.indexOf('</wpt>', wte);
    const wtag = content.substring(ws, wte + 1);
    const wbody = wce !== -1 ? content.substring(wte + 1, wce) : '';
    const wlatM = wtag.match(/\blat="([^"]+)"/);
    const wlonM = wtag.match(/\blon="([^"]+)"/);
    if (wlatM && wlonM) {
      const wlat = parseFloat(wlatM[1]), wlon = parseFloat(wlonM[1]);
      if (!isNaN(wlat) && !isNaN(wlon)) {
        const wNameM = wbody.match(/<name>([\s\S]*?)<\/name>/);
        const wEleM = wbody.match(/<ele>([^<]+)<\/ele>/);
        const wSymM = wbody.match(/<sym>([^<]+)<\/sym>/);
        const wDescM = wbody.match(/<desc>([\s\S]*?)<\/desc>/);
        waypoints.push({
          lat: wlat, lon: wlon,
          ele: wEleM ? parseFloat(wEleM[1]) : null,
          name: wNameM ? unesc(wNameM[1]) : null,
          sym: wSymM ? wSymM[1].trim() : null,
          desc: wDescM ? unesc(wDescM[1]) : null,
        });
      }
    }
    wpos = wce !== -1 ? wce + 6 : wte + 1;
  }

  return { name, date, url, points, waypoints };
}

module.exports = { parseGpx };
