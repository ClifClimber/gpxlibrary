'use strict';
// Activity and zone inference. Pure: sierras and geocoder responses are passed in.

/** Activity from keywords in the name, falling back to distance and climb per km. */
function inferActivity(name, dist, gain) {
  const n = (name || '').toLowerCase();

  if (n.includes('gravel'))                               return { act: 'Gravel',                conf: 'high' };
  if (n.includes('escalad') || n.includes('climbing'))    return { act: 'Escalada',              conf: 'high' };
  if (n.includes('esquí') || n.includes('esqui') || /\bski\b/.test(n)) return { act: 'Esquí de montaña', conf: 'high' };
  if (/trail.?run|running/.test(n))                       return { act: 'Trail Running',         conf: 'high' };
  if (n.includes('senderism') || /\bcaminata\b/.test(n))  return { act: 'Senderismo',            conf: 'high' };
  if (/\bcamino\b/.test(n) && !n.includes('carretera'))   return { act: 'Senderismo',            conf: 'high' };
  if (n.includes('carretera') || n.includes('ciclism'))   return { act: 'Ciclismo de carretera', conf: 'high' };
  if (n.includes('mtb') || n.includes('mountain bike') || n.includes('btt')) return { act: 'MTB', conf: 'high' };
  if (n.includes('bikepacking'))                          return { act: 'Bikepacking',           conf: 'high' };
  if (n.includes('kayak') || n.includes('pirag'))         return { act: 'Kayak',                 conf: 'high' };

  const gpk = dist > 0 ? gain / dist : 0;
  if (dist > 100) return gpk < 15 ? { act: 'Ciclismo de carretera', conf: 'medium' } : { act: 'MTB', conf: 'medium' };
  if (dist > 50) {
    if (gpk < 20) return { act: 'Ciclismo de carretera', conf: 'medium' };
    if (gpk < 50) return { act: 'MTB',                   conf: 'medium' };
    return { act: 'Trail Running', conf: 'medium' };
  }
  if (dist > 20) {
    if (gpk > 60) return { act: 'Trail Running', conf: 'medium' };
    if (gpk > 25) return { act: 'Senderismo',    conf: 'medium' };
    return { act: 'MTB', conf: 'low' };
  }
  return gpk > 60 ? { act: 'Senderismo', conf: 'medium' } : { act: 'Senderismo', conf: 'low' };
}

/** First sierra whose bounding box ({name, sw:[lat,lon], ne:[lat,lon]}) contains the point. */
function sierraFromBbox(lat, lon, sierras) {
  for (const z of sierras || []) {
    if (lat >= z.sw[0] && lat <= z.ne[0] && lon >= z.sw[1] && lon <= z.ne[1]) return z.name;
  }
  return null;
}

const SIERRA_KEYWORDS = [
  'Sierra de ', 'Sierra del ', 'Sierras de ', 'Serra de ', 'Serra del ',
  'Macizo de ', 'Macizo del ', 'Picos de ', 'Cordillera ', 'Sistema ',
  'Montes de ', 'Montes del ',
];

/** Mountain-range name found in a Nominatim reverse-geocoding response, if any. */
function extractSierraFromNominatim(data) {
  if (!data) return null;
  const candidates = [
    data.address?.municipality,
    data.address?.county,
    data.address?.state_district,
    ...(data.display_name || '').split(',').map(s => s.trim()),
  ].filter(Boolean);
  for (const kw of SIERRA_KEYWORDS) {
    for (const c of candidates) {
      if (c.includes(kw)) return c.substring(c.indexOf(kw)).split(',')[0].trim().split(' ').slice(0, 5).join(' ');
    }
  }
  return null;
}

/** Province and autonomous community from a Nominatim reverse-geocoding response. */
function locationFromNominatim(data) {
  const addr = data?.address || {};
  let province = addr.county || addr.state_district || null;
  if (province) province = province.replace(/^Provincia de /i, '').trim();
  return { province, ccaa: addr.state || null };
}

module.exports = { inferActivity, sierraFromBbox, extractSierraFromNominatim, locationFromNominatim };
