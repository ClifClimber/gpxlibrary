(async function(){
'use strict';

let CATALOG;
let gCurrentUser = null;

try {
  const [catRes, meRes] = await Promise.all([fetch('/api/catalog'), fetch('/api/auth/me')]);
  if (!catRes.ok) throw new Error(`HTTP ${catRes.status}`);
  CATALOG = await catRes.json();
  if (meRes.ok) gCurrentUser = await meRes.json();
} catch (err) {
  document.getElementById('tracklist').innerHTML =
    `<div class="empty-state">⚠ No se pudo cargar el catálogo.<p>${err.message}</p></div>`;
  return;
}
if (!Array.isArray(CATALOG) || CATALOG.length === 0) {
  document.getElementById('tracklist').innerHTML =
    '<div class="empty-state">No hay tracks en la base de datos.<p>Importa tracks desde el <a href="/editor">editor</a>.</p></div>';
  // still continue so the map renders
}

const $  = id => document.getElementById(id);
const $$ = sel => [...document.querySelectorAll(sel)];

// ── IBP difficulty levels ────────────────────────────────────────────
const IBP_LEVELS = [
  { label:'Muy fácil', min:0,   max:50,       ...ibpTone('#16a34a') },
  { label:'Fácil',     min:51,  max:100,      ...ibpTone('#ca8a04') },
  { label:'Moderada',  min:101, max:150,      ...ibpTone('#ea580c') },
  { label:'Dura',      min:151, max:250,      ...ibpTone('#dc2626') },
  { label:'Muy dura',  min:251, max:400,      ...ibpTone('#9333ea') },
  { label:'Extrema',   min:401, max:Infinity, color:'var(--bg)', bg:'color-mix(in srgb,var(--ink) 85%,transparent)', border:'var(--ink-2)' },
];
function ibpTone(c) {
  return { color:`color-mix(in srgb,${c} 72%,var(--ink))`, bg:`color-mix(in srgb,${c} 13%,transparent)`, border:`color-mix(in srgb,${c} 40%,transparent)` };
}
const CYCLING_ACTS_V = ['MTB','MTB Enduro','Mtb','Gravel','Bikepacking','Ciclismo de carretera'];
const RUNNING_ACTS_V = ['Trail Running','Running'];
function ibpForTrackV(t) {
  if (CYCLING_ACTS_V.includes(t.activity)) return t.ibp_bicycle;
  if (RUNNING_ACTS_V.includes(t.activity)) return t.ibp_running;
  return t.ibp_hiking;
}
function ibpLevelIdxV(val) {
  if (val == null) return -1;
  return IBP_LEVELS.findIndex(l => val >= l.min && val <= l.max);
}

// ── Activity colors & icons ──────────────────────────────────────────
const ACT_COLORS = {
  'MTB':                   '#7c3aed',
  'MTB Enduro':            '#6d28d9',
  'Gravel':                '#b45309',
  'Bikepacking':           '#92400e',
  'Ciclismo de carretera': '#0369a1',
  'Trail Running':         '#0284c7',
  'Running':               '#0ea5e9',
  'Senderismo':            '#16a34a',
  'Montañismo':            '#15803d',
  'Escalada':              '#dc2626',
  'Esquí de montaña':      '#0e7490',
  'Kayak':                 '#0891b2',
  'Otro':                  '#64748b',
};

const ICON_MTB = `<circle cx="7" cy="17" r="3.2" stroke-width="2.2"/><circle cx="17" cy="17" r="3.2" stroke-width="2.2"/><path stroke-width="2" d="M10.2 17 L13 9 L16.5 13 L17 17"/><path stroke-width="2" d="M13 9 L15 9 L17 13"/><circle cx="15.5" cy="6.5" r="1.8" fill="white" stroke="none"/><path stroke-width="1.8" d="M15 8 L13 10 M15.5 8 L17 11"/>`;
const ICON_MOUNTAIN = `<path fill="white" stroke="none" d="M3 21 L9 9 L13.5 16 L16.5 10.5 L21 21Z"/>`;
const ACT_ICONS = {
  'MTB':                   ICON_MTB,
  'MTB Enduro':            ICON_MTB,
  'Mtb':                   ICON_MTB,
  'Gravel':                `<circle cx="6.5" cy="17" r="3" stroke-width="2.2"/><circle cx="17.5" cy="17" r="3" stroke-width="2.2"/><path stroke-width="2" d="M9.5 17 L13 8 L17.5 13.5 L17.5 17"/><path stroke-width="2" d="M13 8 L15.5 8 L17.5 12"/><circle cx="16" cy="5.5" r="1.8" fill="white" stroke="none"/><path stroke-width="1.8" d="M15.5 7 L14 9.5 M16 7 L18 9"/>`,
  'Bikepacking':           `<circle cx="7" cy="17" r="3" stroke-width="2.2"/><circle cx="17" cy="17" r="3" stroke-width="2.2"/><path stroke-width="2" d="M10 17 L13 9 L16.5 13 L17 17"/><path stroke-width="2" d="M13 9 L15 9 L17 13"/><rect x="12.5" y="9.5" width="3" height="2.5" rx="0.5" fill="white" stroke="none"/><circle cx="15.5" cy="7" r="1.8" fill="white" stroke="none"/>`,
  'Ciclismo de carretera': `<circle cx="6" cy="17" r="3" stroke-width="2.2"/><circle cx="18" cy="17" r="3" stroke-width="2.2"/><path stroke-width="2" d="M9 17 L12 7.5 L18 13.5 L18 17"/><path stroke-width="2" d="M12 7.5 L14.5 7.5 L18 12.5"/><circle cx="15" cy="5" r="1.8" fill="white" stroke="none"/><path stroke-width="1.8" d="M14.5 6.5 L13 9.5 M15 6.5 L17 8"/>`,
  'Trail Running':         `<circle cx="13" cy="4" r="1.8" fill="white" stroke="none"/><path stroke-width="2.5" d="M13 5.8 L11 11 L8 14.5 M11 11 L13.5 15 L12 20 M8 14.5 L7 20 M13 5.8 L16 9"/><path stroke-width="2" d="M11 11 L14 9.5 L16 11"/>`,
  'Running':               `<circle cx="14" cy="4" r="1.8" fill="white" stroke="none"/><path stroke-width="2.5" d="M14 5.8 L12 11 L9 9.5 M12 11 L14 16 L11 20 M14 16 L17 20 M14 5.8 L16 10"/><path stroke-width="2" d="M9 9.5 L7.5 11 M16 10 L18 9"/>`,
  'Senderismo':            `<circle cx="12" cy="4" r="1.8" fill="white" stroke="none"/><path stroke-width="2.5" d="M12 5.8 L11 12 L9.5 20 M11 12 L13 20"/><path stroke-width="2" d="M12 5.8 L15 9 M11 9 L9 10 L8.5 20"/><path stroke-width="1.5" d="M9 10 L7 8"/>`,
  'Montañismo':            ICON_MOUNTAIN,
  'Apinismo':              ICON_MOUNTAIN,
  'Escalada':              `<line x1="3.5" y1="2" x2="3.5" y2="22" stroke-width="2.5"/><path stroke-width="1.5" d="M3.5 6 L7 7 M3.5 12 L7 13 M3.5 18 L7 19"/><circle cx="17" cy="5" r="1.8" fill="white" stroke="none"/><path stroke-width="2" d="M17 6.8 L14.5 10 L12 9 M14.5 10 L13.5 16 L11.5 21 M13.5 16 L16.5 19 M17 6.8 L19 9"/><path stroke-width="1.5" d="M3.5 10 L12 9"/>`,
  'Ferratas':              `<line x1="3.5" y1="2" x2="3.5" y2="22" stroke-width="2.5"/><path stroke-width="1.5" d="M3.5 5 L6 5 M3.5 9 L6 9 M3.5 13 L6 13 M3.5 17 L6 17"/><circle cx="17" cy="5" r="1.8" fill="white" stroke="none"/><path stroke-width="2" d="M17 6.8 L15 10 L12 9 M15 10 L14 17 L12 21 M14 17 L17 20 M17 6.8 L19 9"/><path stroke-width="1.5" d="M3.5 9 L12 9"/>`,
  'Esquí de montaña':      `<circle cx="13" cy="4" r="1.8" fill="white" stroke="none"/><path stroke-width="2.5" d="M13 5.8 L11 11 L8 12.5 M11 11 L12 18 M13 5.8 L15 9 L17 10"/><path stroke-width="1.5" d="M8 12.5 L6 14 M17 10 L18 14"/><path stroke-width="2.5" d="M5 21 L13 22 L17 21"/>`,
  'Kayak':                 `<circle cx="12" cy="4" r="1.8" fill="white" stroke="none"/><path stroke-width="2.5" d="M12 5.8 L11 9.5 L12 14"/><path stroke-width="2" d="M8.5 9.5 L15.5 9.5"/><path stroke-width="2" fill="white" d="M4 16 Q12 13.5 20 16 Q12 18.5 4 16Z"/><path stroke-width="2" d="M3 9 L8 10 M16 10 L21 9"/><path stroke-width="2" d="M3 8.5 L3 9.5 M21 8.5 L21 9.5"/>`,
  'Otro':                  `<path fill="white" stroke="none" d="M12 2.5C8.8 2.5 6.5 5.3 6.5 8.6c0 4.9 5.5 12.9 5.5 12.9s5.5-8 5.5-12.9C17.5 5.3 15.2 2.5 12 2.5z"/>`,
};

let actIconsCustom = {};
let actColorsCustom = {};
let trackColors = {};
const PALETTE = ['#e67e22','#27ae60','#8e44ad','#2980b9','#e74c3c','#16a085','#f39c12','#c0392b','#1abc9c','#d35400','#2c3e50','#7f8c8d'];
let actColorIdx = 0;
const autoColors = {};

function loadColors() {
  try { actColorsCustom = JSON.parse(localStorage.getItem('gpx-act-colors')   || '{}'); } catch {}
  try { trackColors     = JSON.parse(localStorage.getItem('gpx-track-colors') || '{}'); } catch {}
  try { actIconsCustom  = JSON.parse(localStorage.getItem('gpx-act-icons')    || '{}'); } catch {}
}
function saveActColors()   { try { localStorage.setItem('gpx-act-colors',   JSON.stringify(actColorsCustom)); } catch {} }
function saveTrackColors() { try { localStorage.setItem('gpx-track-colors', JSON.stringify(trackColors));     } catch {} }

function actColor(act) {
  if (actColorsCustom[act]) return actColorsCustom[act];
  if (ACT_COLORS[act]) return ACT_COLORS[act];
  return autoColors[act] || (autoColors[act] = PALETTE[actColorIdx++ % PALETTE.length]);
}
function getTrackColor(track) { return trackColors[track.file] || actColor(track.activity || 'Otro'); }

function actIconInner(act) {
  const customSrc = actIconsCustom[act];
  if (customSrc) return `<img src="${escHtml(customSrc)}" alt="">`;
  return `<svg viewBox="0 0 24 24">${ACT_ICONS[act] || ACT_ICONS['Otro']}</svg>`;
}
function makeActivityIcon(act, color) {
  return L.divIcon({
    html: `<div class="act-marker" style="background:${color}">${actIconInner(act)}</div>`,
    className: 'act-marker-wrap',
    iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -15],
  });
}

loadColors();

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

// Precompute a normalized search string per track (name + zone + tags)
CATALOG.forEach(t => { t._q = norm([t.name, t.sierra, t.zone, ...(t.tags || [])].filter(Boolean).join(' ')); });

// ── Map ──────────────────────────────────────────────────────────────
const map = L.map('map', { center:[40.4,-3.7], zoom:7, zoomControl:false, renderer:L.canvas({ tolerance:4 }) });

const tileLayers = {
  'Claro':           L.layerGroup([L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution:'© <a href="https://www.esri.com">Esri</a>, HERE, Garmin, © OpenStreetMap', maxZoom:16 }), L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom:16 })]),
  'Oscuro':          L.layerGroup([L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution:'© <a href="https://www.esri.com">Esri</a>, HERE, Garmin, © OpenStreetMap', maxZoom:16 }), L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom:16 })]),
  'OpenStreetMap':   L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom:19 }),
  'OpenTopoMap':     L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',   { attribution:'© OpenTopoMap', maxZoom:17 }),
  'IGN Topográfico': L.tileLayer('https://www.ign.es/wmts/mapa-raster?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=MTN&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', { attribution:'© <a href="https://www.ign.es">IGN España</a>', maxZoom:20 }),
  'Google Maps':     L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { subdomains:'0123', attribution:'© Google', maxZoom:20 }),
  'Google Satélite': L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { subdomains:'0123', attribution:'© Google', maxZoom:20 }),
  'Google Híbrido':  L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { subdomains:'0123', attribution:'© Google', maxZoom:20 }),
};
let baseName = 'Claro';
try { const s = localStorage.getItem('visor-base-layer'); if (tileLayers[s]) baseName = s; } catch {}
tileLayers[baseName].addTo(map);
map.on('baselayerchange', e => { try { localStorage.setItem('visor-base-layer', e.name); } catch {} });
map.on('moveend zoomend', () => applyFilters());
L.control.layers(tileLayers, null, { position:'topright', collapsed:true }).addTo(map);
L.control.zoom({ position:'topright' }).addTo(map);

// Padding that keeps fitted bounds clear of the floating panels
function fitPadding() {
  const appR = $('app').getBoundingClientRect();
  const mobile = window.innerWidth <= 760;
  let left = 24, top = 24, right = 64, bottom = 24;
  const chipsR = $('chips').getBoundingClientRect();
  top = Math.max(top, chipsR.bottom - appR.top + 16);
  const panel = $('panel');
  if (!mobile && !$('app').classList.contains('panel-collapsed')) {
    left = panel.getBoundingClientRect().right - appR.left + 24;
  }
  const prof = $('profile');
  if (prof.classList.contains('visible')) bottom = appR.bottom - prof.getBoundingClientRect().top + 16;
  if (mobile) bottom = Math.max(bottom, appR.bottom - panel.getBoundingClientRect().top + 16);
  return { paddingTopLeft:[left, top], paddingBottomRight:[right, bottom] };
}
function fitTo(bounds, maxZoom) {
  map.fitBounds(bounds, { ...fitPadding(), maxZoom: maxZoom || 16 });
}

// ── Segment highlight & hover marker ─────────────────────────────────
const segHL = {
  _layers: [],
  show(latlngs, color) {
    this.hide();
    // Keep the main track fully visible — only add the segment highlight on top
    this._layers.push(
      L.polyline(latlngs, { color:'#111827', weight:8,  opacity:0.45, interactive:false, lineCap:'round', lineJoin:'round' }).addTo(map),
      L.polyline(latlngs, { color,           weight:4,  opacity:1,    interactive:false, lineCap:'round', lineJoin:'round' }).addTo(map)
    );
    this._layers.forEach(l => l.bringToFront());
  },
  hide() {
    this._layers.forEach(l => l.remove()); this._layers = [];
    // No need to restore the main track — we never changed its opacity
  }
};
const hoverMarker = L.circleMarker([0,0], { radius:7, color:'white', weight:2.5, fillOpacity:1, interactive:false, pane:'shadowPane' });

let PS = null;
let activeIdx = null;
let sliders = {};
let geoFilter = null;   // {lat, lon, radius, name}
let gOwnerFilter = null; // null = todas; o un owner_id para filtrar por propietario
let geoCircle = null;
let idSet = new Set();   // filter to specific IDs (from ?ids= URL param)
let sortMode = 'name';
try { sortMode = localStorage.getItem('visor-sort') || 'name'; } catch {}

// ── Markers + polylines ──────────────────────────────────────────────
const items = CATALOG.map((track, i) => {
  const color = getTrackColor(track);
  const layer = L.polyline(track.points.map(p=>[p[0],p[1]]), { color, weight:3, opacity:0.8, interactive:true });
  layer.on('click', () => activateTrack(i, true));
  layer.on('mousemove', e => {
    if (activeIdx !== i || !PS?.geom) return;
    let ci = 0, best = Infinity;
    PS.geom.pts.forEach((p, idx) => { const d = e.latlng.distanceTo(L.latLng(p[0],p[1])); if (d < best) { best = d; ci = idx; } });
    syncCursorSvg(ci);
  });
  layer.on('mouseout', () => { if (activeIdx === i) hideCursor(); });

  const sp = track.points[0];
  const marker = sp ? L.marker([sp[0], sp[1]], { icon: makeActivityIcon(track.activity || 'Otro', color), title: track.name }) : null;
  if (marker) {
    marker.on('mouseover', () => previewTrack(i, true));
    marker.on('mouseout',  () => previewTrack(i, false));
    marker.on('click',     () => activateTrack(i, true));
  }
  return { track, layer, marker, visible:true };
});

const cluster = L.markerClusterGroup({
  showCoverageOnHover: false, maxClusterRadius: 44, disableClusteringAtZoom: 12, spiderfyOnMaxZoom: true, chunkedLoading: true,
  iconCreateFunction: c => {
    const n = c.getChildCount();
    const sz = n < 10 ? 34 : n < 50 ? 40 : 46;
    return L.divIcon({ html: `<span>${n}</span>`, className: 'track-cluster', iconSize: [sz, sz] });
  },
}).addTo(map);
cluster.addLayers(items.map(it => it.marker).filter(Boolean));
let _clusterKey = '';
function syncClusterMarkers() {
  const vis = items.filter(it => it.visible && it.marker);
  const key = vis.map(it => it.track.id).join(',');
  if (key === _clusterKey) return;
  _clusterKey = key;
  cluster.clearLayers();
  cluster.addLayers(vis.map(it => it.marker));
}

function previewTrack(i, on) {
  if (activeIdx === i) return;
  if (activeIdx !== null) return; // don't show other tracks while one is active
  const { layer } = items[i];
  if (on) { layer.setStyle({ weight:3.5, opacity:0.9 }); layer.addTo(map); layer.bringToFront(); }
  else layer.remove();
}

// ── Color pickers ────────────────────────────────────────────────────
function pickColor(currentColor, onInput, onFinal) {
  const inp = document.createElement('input');
  inp.type = 'color'; inp.value = currentColor;
  Object.assign(inp.style, { position:'fixed', opacity:'0', pointerEvents:'none', width:'1px', height:'1px', top:'0', left:'0' });
  document.body.appendChild(inp);
  if (onInput) inp.addEventListener('input',  e => onInput(e.target.value));
  if (onFinal) inp.addEventListener('change', e => { onFinal(e.target.value); setTimeout(() => inp.remove(), 100); });
  inp.click();
}

function setActivityColor(act, color, save) {
  actColorsCustom[act] = color;
  if (save) saveActColors();
  items.forEach(({ track, layer, marker }) => {
    if ((track.activity||'Otro') === act && !trackColors[track.file]) {
      layer.setStyle({ color });
      if (marker) marker.setIcon(makeActivityIcon(act, color));
    }
  });
  $$('.cat-pill[data-activity]').forEach(p => {
    if (p.dataset.activity === act) { const dot = p.querySelector('.cat-dot'); if (dot) dot.style.background = color; }
  });
  renderList(true);
  if (activeIdx !== null) {
    const tr = items[activeIdx].track;
    if ((tr.activity||'Otro') === act && !trackColors[tr.file]) fillDetailHeader(tr, color);
  }
}

function setTrackColor(track, color, save) {
  trackColors[track.file] = color;
  if (save) saveTrackColors();
  const item = items.find(it => it.track === track);
  if (item) {
    item.layer.setStyle({ color });
    if (item.marker) item.marker.setIcon(makeActivityIcon(track.activity || 'Otro', color));
  }
  renderList(true);
  if (activeIdx !== null && items[activeIdx].track === track) fillDetailHeader(track, color);
}

// Seed activity colors from DB if not already customised locally
fetch('/api/config/activities')
  .then(r => r.json())
  .then(acts => {
    let changed = false;
    acts.forEach(a => {
      if (a.color && !actColorsCustom[a.name]) { actColorsCustom[a.name] = a.color; changed = true; }
    });
    if (changed) acts.forEach(a => { if (a.color) setActivityColor(a.name, actColorsCustom[a.name], false); });
  })
  .catch(() => {});

// Live sync when config.html (or another tab) changes colors/icons
window.addEventListener('storage', e => {
  if (e.key === 'gpx-act-colors' && e.newValue) {
    try {
      const newColors = JSON.parse(e.newValue);
      Object.entries(newColors).forEach(([act, color]) => { if (actColorsCustom[act] !== color) setActivityColor(act, color, false); });
      actColorsCustom = newColors;
    } catch {}
  }
  if (e.key === 'gpx-act-icons' && e.newValue) {
    try {
      actIconsCustom = JSON.parse(e.newValue);
      items.forEach(({ track, marker }) => { if (marker) marker.setIcon(makeActivityIcon(track.activity || 'Otro', getTrackColor(track))); });
      renderList(true);
    } catch {}
  }
});

// ── Haversine & geo helpers ──────────────────────────────────────────
function hav(lat1, lon1, lat2, lon2) {
  const R = 6371, D = Math.PI/180;
  const dl = (lat2-lat1)*D, dn = (lon2-lon1)*D;
  const a = Math.sin(dl/2)**2 + Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dn/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
function trackNearPoint(track, lat, lon, radiusKm) {
  if (hav(lat, lon, track.center[0], track.center[1]) <= radiusKm) return true;
  return (track.points || []).some(p => hav(lat, lon, p[0], p[1]) <= radiusKm);
}

function geoRadius() {
  const a = document.querySelector('#geo-radius .cat-pill.active');
  return a ? parseInt(a.dataset.r) : 25;
}
function setGeo(lat, lon, name) {
  geoFilter = { lat, lon, radius: geoRadius(), name };
  drawGeo(true);
  applyFilters();
}
function drawGeo(fit) {
  if (geoCircle) geoCircle.remove();
  geoCircle = L.circle([geoFilter.lat, geoFilter.lon], {
    radius: geoFilter.radius * 1000,
    color: '#006783', weight: 1.5, opacity: .8, dashArray: '6 5',
    fillColor: '#bce9ff', fillOpacity: .12, interactive: false
  }).addTo(map);
  const short = geoFilter.name.split(',')[0];
  $('chip-geo-lbl').textContent = `${short} · ${geoFilter.radius} km`;
  $('geo-place-name').textContent = geoFilter.name;
  $('chip-geo').hidden = false;
  if (fit) fitTo(geoCircle.getBounds(), 13);
}
function clearGeoFilter() {
  geoFilter = null;
  if (geoCircle) { geoCircle.remove(); geoCircle = null; }
  $('chip-geo').hidden = true;
  closePopover();
}

// ── Dual slider ──────────────────────────────────────────────────────
function initDualSlider(minId, maxId, fillId, labelId, lo, hi, step, unit, onChange) {
  const minR = $(minId), maxR = $(maxId), fill = $(fillId), label = $(labelId);
  minR.min = maxR.min = lo; minR.max = maxR.max = hi;
  minR.step = maxR.step = step;
  minR.value = lo; maxR.value = hi;
  const fmt = v => nf0.format(v);
  function summary() {
    const mn = +minR.value, mx = +maxR.value;
    if (mx >= hi) return mn > lo ? `≥ ${fmt(mn)} ${unit}` : '';
    if (mn <= lo) return `≤ ${fmt(mx)} ${unit}`;
    return `${fmt(mn)}–${fmt(mx)} ${unit}`;
  }
  function sync() {
    const p1 = (minR.value - lo) / (hi - lo) * 100;
    const p2 = (maxR.value - lo) / (hi - lo) * 100;
    fill.style.left = p1 + '%'; fill.style.width = (p2 - p1) + '%';
    label.textContent = summary() || `Cualquiera`;
  }
  let raf = 0;
  const changed = () => { sync(); cancelAnimationFrame(raf); raf = requestAnimationFrame(onChange); };
  minR.addEventListener('input', () => { if (+minR.value > +maxR.value) minR.value = maxR.value; changed(); });
  maxR.addEventListener('input', () => { if (+maxR.value < +minR.value) maxR.value = minR.value; changed(); });
  sync();
  return {
    getMin:   () => +minR.value,
    getMax:   () => +maxR.value >= hi ? Infinity : +maxR.value,
    isActive: () => +minR.value > lo || +maxR.value < hi,
    reset:    () => { minR.value = lo; maxR.value = hi; sync(); },
    summary,
  };
}

// ── Activate / deactivate ────────────────────────────────────────────
function activateTrack(i, fitMap) {
  if (activeIdx !== null && items[activeIdx]) {
    const prev = items[activeIdx];
    prev.layer.remove();
    prev.layer.setStyle({ weight:3, opacity:0.8 });
    prev.marker?.getElement()?.querySelector('.act-marker')?.classList.remove('active-marker');
    prev.marker?.setZIndexOffset(0);
  }
  activeIdx = i;
  const { track, layer, marker } = items[i];
  layer.setStyle({ weight:4.5, opacity:1 });
  layer.addTo(map); layer.bringToFront();
  marker?.getElement()?.querySelector('.act-marker')?.classList.add('active-marker');
  marker?.setZIndexOffset(1000);
  const color = getTrackColor(track);
  fillDetailHeader(track, color);
  showProfile(track, color);
  if (fitMap) fitTo(L.latLngBounds(track.bounds[0], track.bounds[1]));
  $$('.track-item.active').forEach(el => el.classList.remove('active'));
  const el = document.querySelector(`.track-item[data-idx="${i}"]`);
  if (el) { el.classList.add('active'); el.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
}

function deactivateTrack() {
  if (activeIdx !== null && items[activeIdx]) {
    const it = items[activeIdx];
    it.layer.remove();
    it.layer.setStyle({ weight:3, opacity:0.8 });
    it.marker?.getElement()?.querySelector('.act-marker')?.classList.remove('active-marker');
    it.marker?.setZIndexOffset(0);
  }
  activeIdx = null;
  $$('.track-item.active').forEach(el => el.classList.remove('active'));
  $('profile').classList.remove('visible');
  $('sel-bar').classList.remove('visible');
  hoverMarker.remove();
  segHL.hide();
  PS = null;
}

// ── Detail header ────────────────────────────────────────────────────
function fillDetailHeader(track, color) {
  const swatch = $('pd-color-swatch');
  swatch.style.background = color;
  swatch.onclick = () => pickColor(getTrackColor(track), c => setTrackColor(track, c, false), c => setTrackColor(track, c, true));

  $('pd-name').textContent = track.name;
  $('pd-name').title = track.name;
  const act = track.activity || 'Otro';
  const catEl = $('pd-cat');
  catEl.textContent = track.activity || 'Sin actividad';
  catEl.style.setProperty('--pc', actColor(act));
  catEl.onclick = () => pickColor(actColor(act), c => setActivityColor(act, c, false), c => setActivityColor(act, c, true));

  function fmtSec(s) {
    if (!s) return null;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  const movT  = fmtSec(track.movingTime);
  const totT  = fmtSec((track.movingTime || 0) + (track.stoppedTime || 0));

  const distEl = $('pd-dist');
  distEl.innerHTML = `&#128207; <b>${nf1.format(track.distance)}</b> km`;
  distEl.title = 'Distancia total del recorrido';

  const gainEl = $('pd-gain');
  gainEl.innerHTML = `↗<b>${nf0.format(track.elevationGain)}</b>&thinsp;m &nbsp;↘<b>${nf0.format(track.elevationLoss)}</b>&thinsp;m`;
  gainEl.title = 'Desnivel acumulado positivo / negativo';

  $('pd-loss').innerHTML = '';

  const altEl = $('pd-alt');
  if (movT) {
    altEl.innerHTML = `⏱<b>${movT}</b>${totT && totT !== movT ? `&nbsp;·&nbsp;<b>${totT}</b>` : ''}`;
    altEl.title = totT && totT !== movT ? 'Tiempo en movimiento · tiempo total' : 'Tiempo en movimiento';
  } else {
    altEl.innerHTML = track.date ? `<b>${escHtml(track.date)}</b>` : '';
    altEl.title = 'Fecha';
  }
  $('pd-date').innerHTML = '';

  const detailEl = $('pd-detail');
  if (track.id) { detailEl.href = `/track?id=${track.id}`; detailEl.hidden = false; }
  else detailEl.hidden = true;
}

// ── Elevation profile ────────────────────────────────────────────────
function showProfile(track, color) {
  const panel = $('profile'), svgEl = $('profile-svg'), noEleEl = $('no-elevation');
  panel.classList.add('visible');
  $('sel-bar').classList.remove('visible');
  segHL.hide(); hoverMarker.remove(); PS = null;

  const pts = track.points.filter(p => p.length === 3 && p[2] != null);
  if (pts.length < 2) { svgEl.style.display = 'none'; noEleEl.style.display = 'flex'; return; }
  svgEl.style.display = 'block'; noEleEl.style.display = 'none';

  const dists = [0];
  for (let i = 1; i < pts.length; i++) dists.push(dists[i-1] + hav(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]));
  const totalDist = dists[dists.length-1] || 1;
  const eles = pts.map(p => p[2]);
  const minEle = Math.min(...eles), maxEle = Math.max(...eles), eleRange = (maxEle-minEle) || 1;

  requestAnimationFrame(() => {
    const rect = svgEl.getBoundingClientRect();
    const W = rect.width || 600, H = rect.height || 140;
    const P = { t:10, r:12, b:22, l:44 };
    const CW = W-P.l-P.r, CH = H-P.t-P.b;
    const toX = d => P.l + (d/totalDist)*CW;
    const toY = e => P.t + (1-(e-minEle)/eleRange)*CH;
    const coords = eles.map((e,i) => [toX(dists[i]), toY(e)]);
    const lineD = 'M' + coords.map(p => p.join(',')).join(' L');
    const areaD = `M${P.l},${P.t+CH} L${coords.map(p => p.join(',')).join(' L')} L${P.l+CW},${P.t+CH} Z`;
    const yTicks = [0,.5,1].map(f => ({ y:toY(minEle+f*eleRange), val:Math.round(minEle+f*eleRange) }));
    const rawStep = totalDist/6;
    const xStep = rawStep>=20 ? Math.ceil(rawStep/10)*10 : rawStep>=5 ? 5 : rawStep>=2 ? 2 : rawStep>=1 ? 1 : 0.5;
    const xTicks = [];
    for (let d = 0; d <= totalDist+.001; d += xStep) if (toX(d) <= P.l+CW+1) xTicks.push({ x:toX(d), val:+d.toFixed(1) });

    const gid = 'g' + Math.random().toString(36).slice(2,6);
    svgEl.innerHTML = `
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity=".35"/>
          <stop offset="100%" stop-color="${color}" stop-opacity=".03"/>
        </linearGradient>
        <clipPath id="cp${gid}"><rect x="${P.l}" y="${P.t}" width="${CW}" height="${CH}"/></clipPath>
      </defs>
      ${yTicks.map(t => `<line x1="${P.l}" y1="${t.y}" x2="${P.l+CW}" y2="${t.y}" stroke="#eef2f6" stroke-width="1"/>
        <text x="${P.l-6}" y="${t.y+3.5}" text-anchor="end" font-size="10" fill="#94a3b8">${t.val}</text>`).join('')}
      ${xTicks.map(t => `<text x="${t.x}" y="${P.t+CH+15}" text-anchor="middle" font-size="10" fill="#94a3b8">${t.val} km</text>`).join('')}
      <path d="${areaD}" fill="url(#${gid})"/>
      <path d="${lineD}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <rect id="sel-rect" x="0" y="${P.t}" width="0" height="${CH}" fill="${color}" fill-opacity=".16"
            stroke="${color}" stroke-opacity=".5" stroke-width="1" clip-path="url(#cp${gid})" style="display:none"/>
      <line id="sel-s" x1="0" y1="${P.t}" x2="0" y2="${P.t+CH}" stroke="${color}" stroke-width="2" style="display:none"/>
      <line id="sel-e" x1="0" y1="${P.t}" x2="0" y2="${P.t+CH}" stroke="${color}" stroke-width="2" style="display:none"/>
      <line id="phl" x1="0" y1="${P.t}" x2="0" y2="${P.t+CH}" style="stroke:var(--ink-3)" stroke-width="1" stroke-dasharray="3,2" opacity="0" pointer-events="none"/>
      <circle id="phd" r="4.5" fill="${color}" stroke="white" stroke-width="2" opacity="0" pointer-events="none"/>
      <rect id="pho" x="${P.l}" y="${P.t}" width="${CW}" height="${CH}" fill="transparent" style="cursor:crosshair"/>
    `;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const hLine = svgEl.querySelector('#phl'), hDot = svgEl.querySelector('#phd');
    const selRect = svgEl.querySelector('#sel-rect');
    const selS = svgEl.querySelector('#sel-s'), selE = svgEl.querySelector('#sel-e');
    const overlay = svgEl.querySelector('#pho');
    const tooltip = $('profile-tooltip');
    const wrap = $('profile-svg-wrap');

    const geom = { pts, dists, eles, totalDist, minEle, maxEle, eleRange, W, H, P, CW, CH, toX, toY };
    PS = { geom, hLine, hDot };

    const svgMx = e => { const r = svgEl.getBoundingClientRect(); return (e.clientX - r.left) * (W / r.width); };
    function closestIdx(sx) {
      const td = ((sx - P.l) / CW) * totalDist;
      let ci = 0, best = Infinity;
      dists.forEach((d, i) => { const dd = Math.abs(d - td); if (dd < best) { best = dd; ci = i; } });
      return Math.max(0, Math.min(pts.length-1, ci));
    }
    function moveCursorAt(ci) {
      const cx = toX(dists[ci]), cy = toY(eles[ci]);
      hLine.setAttribute('x1',cx); hLine.setAttribute('x2',cx); hLine.setAttribute('opacity','1');
      hDot.setAttribute('cx',cx); hDot.setAttribute('cy',cy); hDot.setAttribute('opacity','1');
    }
    function showTip(ci) {
      tooltip.style.display = 'block';
      tooltip.textContent = `${Math.round(eles[ci])} m · ${nf1.format(dists[ci])} km`;
      const wr = wrap.getBoundingClientRect(), sr = svgEl.getBoundingClientRect();
      const px = sr.left + toX(dists[ci])*(sr.width/W) - wr.left;
      const py = sr.top + toY(eles[ci])*(sr.height/H) - wr.top;
      tooltip.style.left = Math.max(0, Math.min(wr.width - tooltip.offsetWidth, px - tooltip.offsetWidth/2)) + 'px';
      tooltip.style.top  = Math.max(0, py - 32) + 'px';
    }
    function moveMapMark(ci) {
      hoverMarker.setStyle({ fillColor: color });
      hoverMarker.setLatLng([pts[ci][0], pts[ci][1]]).addTo(map);
    }

    let drag = { active:false, s:null, e:null };
    function drawSel(i0, i1) {
      const x0 = toX(dists[i0]), x1 = toX(dists[i1]);
      selRect.setAttribute('x',x0); selRect.setAttribute('width',Math.max(1,x1-x0)); selRect.style.display = '';
      selS.setAttribute('x1',x0); selS.setAttribute('x2',x0); selS.style.display = '';
      selE.setAttribute('x1',x1); selE.setAttribute('x2',x1); selE.style.display = '';
      let segGain = 0, segLoss = 0;
      for (let k = i0+1; k <= i1; k++) { const diff = eles[k]-eles[k-1]; if (diff > 0) segGain += diff; else segLoss -= diff; }
      $('sel-dist').innerHTML = `<b>${nf1.format(dists[i1]-dists[i0])}</b> km`;
      $('sel-gain').innerHTML = `↑ <b>${nf0.format(segGain)}</b> m`;
      $('sel-loss').innerHTML = `↓ <b>${nf0.format(segLoss)}</b> m`;
      $('sel-bar').classList.add('visible');
      segHL.show(pts.slice(i0, i1+1).map(p => [p[0],p[1]]), color);
    }
    function clearSel() {
      selRect.style.display = 'none'; selS.style.display = 'none'; selE.style.display = 'none';
      $('sel-bar').classList.remove('visible');
      segHL.hide(); drag = { active:false, s:null, e:null };
    }

    overlay.addEventListener('mousedown', e => {
      e.preventDefault();
      const ci = closestIdx(svgMx(e));
      drag = { active:true, s:ci, e:ci };
      selRect.style.display = 'none'; selS.style.display = 'none'; selE.style.display = 'none';
      $('sel-bar').classList.remove('visible');
      segHL.hide();
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', onDrop);
    });
    function onDrag(e) {
      if (!drag.active) return;
      const ci = closestIdx(svgMx(e)); drag.e = ci;
      moveCursorAt(ci); moveMapMark(ci); showTip(ci);
      const i0 = Math.min(drag.s, drag.e), i1 = Math.max(drag.s, drag.e);
      if (i1 > i0) drawSel(i0, i1);
    }
    function onDrop() {
      drag.active = false;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onDrop);
      if (drag.s !== null && drag.e !== null && Math.abs(drag.s - drag.e) < 2) clearSel();
    }
    overlay.addEventListener('mousemove', e => {
      if (drag.active) return;
      const ci = closestIdx(svgMx(e));
      moveCursorAt(ci); moveMapMark(ci); showTip(ci);
    });
    overlay.addEventListener('mouseleave', () => {
      if (drag.active) return;
      hLine.setAttribute('opacity','0'); hDot.setAttribute('opacity','0');
      tooltip.style.display = 'none'; hoverMarker.remove();
    });
    $('sel-clear').onclick = clearSel;
  });
}

function syncCursorSvg(ci) {
  if (!PS?.hLine) return;
  const { geom, hLine, hDot } = PS;
  const cx = geom.toX(geom.dists[ci]), cy = geom.toY(geom.eles[ci]);
  hLine.setAttribute('x1',cx); hLine.setAttribute('x2',cx); hLine.setAttribute('opacity','1');
  hDot.setAttribute('cx',cx); hDot.setAttribute('cy',cy); hDot.setAttribute('opacity','1');
}
function hideCursor() {
  if (!PS?.hLine) return;
  PS.hLine.setAttribute('opacity','0'); PS.hDot.setAttribute('opacity','0');
  hoverMarker.remove();
  $('profile-tooltip').style.display = 'none';
}

// ── Filter state ─────────────────────────────────────────────────────
function readFilters() {
  const ibpMin = parseInt($('ibp-rs-min').value), ibpMax = parseInt($('ibp-rs-max').value);
  return {
    acts:    new Set($$('#cat-filters .cat-pill.active').map(el => el.dataset.activity)),
    sierras: new Set($$('#sierra-filters .cat-pill.active').map(el => el.dataset.sierra)),
    tags:    new Set($$('#tag-filters .cat-pill.active').map(el => el.dataset.tag)),
    rtype:   new Set($$('#route-type-filters .cat-pill.active').map(el => el.dataset.rtype)),
    distMin: sliders.dist?.getMin() ?? 0, distMax: sliders.dist?.getMax() ?? Infinity,
    eleMin:  sliders.ele?.getMin()  ?? 0, eleMax:  sliders.ele?.getMax()  ?? Infinity,
    year:    $('year-filter').value,
    q:       norm($('text-search').value.trim()),
    ibpMin, ibpMax, ibpActive: ibpMin > 0 || ibpMax < 5,
    owner: gOwnerFilter,
  };
}

// All filters except activity / sierra / tags (those are cascaded)
function baseMatch(t, f) {
  return t.distance >= f.distMin && t.distance <= f.distMax &&
    t.elevationGain >= f.eleMin && t.elevationGain <= f.eleMax &&
    (!f.year || (t.date && t.date.startsWith(f.year))) &&
    (!f.q || t._q.includes(f.q)) &&
    (!geoFilter || trackNearPoint(t, geoFilter.lat, geoFilter.lon, geoFilter.radius)) &&
    (!f.ibpActive || (() => { const idx = ibpLevelIdxV(ibpForTrackV(t)); return idx >= f.ibpMin && idx <= f.ibpMax; })()) &&
    (f.rtype.size === 0 || (f.rtype.has('circular') && t.circular) || (f.rtype.has('lineal') && !t.circular)) &&
    (f.owner == null || t.owner_id === f.owner);
}
const actOk    = (t, f) => f.acts.size === 0    || f.acts.has(t.activity || 'Sin clasificar');
const sierraOk = (t, f) => f.sierras.size === 0 || f.sierras.has(t.sierra);
const tagsOk   = (t, f) => f.tags.size === 0    || (t.tags || []).some(x => f.tags.has(x));

function applyFilters() {
  const f = readFilters();
  const vb = map.getBounds();
  let totalDist = 0, totalEle = 0, visCount = 0;
  items.forEach((it, i) => {
    const t = it.track;
    const inView = !t.bounds || vb.intersects(L.latLngBounds(t.bounds[0], t.bounds[1]));
    const ok = inView && (idSet.size === 0 || idSet.has(t.id)) &&
      baseMatch(t, f) && actOk(t, f) && sierraOk(t, f) && tagsOk(t, f);
    it.visible = ok;
    if (ok) {
      visCount++; totalDist += t.distance || 0; totalEle += t.elevationGain || 0;
    } else if (activeIdx === i) it.layer.remove();
  });
  syncClusterMarkers();
  _listPage = 0;
  $('list-count').innerHTML = visCount === CATALOG.length
    ? `${visCount} rutas`
    : `${visCount} rutas <small>de ${CATALOG.length}</small>`;
  $('list-summary').textContent = visCount
    ? `${nf0.format(totalDist)} km · ${nf0.format(totalEle)} m de desnivel acumulado`
    : '';
  renderList();
  updateChips(f);
  try { updateFilterCounts(f); } catch (e) { console.error('updateFilterCounts:', e); }
}

// ── List ─────────────────────────────────────────────────────────────
const SORTERS = {
  'name':      (a, b) => a.name.localeCompare(b.name, 'es'),
  'date':      (a, b) => (b.date || '').localeCompare(a.date || ''),
  'id-desc':   (a, b) => (b.id || 0) - (a.id || 0),
  'dist-asc':  (a, b) => a.distance - b.distance,
  'dist-desc': (a, b) => b.distance - a.distance,
  'ele-desc':  (a, b) => b.elevationGain - a.elevationGain,
  'ibp-asc':   (a, b) => (ibpForTrackV(a) ?? 9999) - (ibpForTrackV(b) ?? 9999),
};

// Foto representativa por actividad (si no hay, el item queda en gris claro).
const ACT_PHOTOS = {
  'Trail Running': '/assets/activities/trail-running.jpg',
  'Running':       '/assets/activities/trail-running.jpg',
  'MTB':           '/assets/activities/mtb.jpg',
  'MTB Enduro':    '/assets/activities/mtb.jpg',
  'Gravel':        '/assets/activities/gravel.jpg',
  'Montañismo':    '/assets/activities/montanismo.jpg',
  'Esquí Travesia': '/assets/activities/travesia.jpg',
};

function trackItemHtml(track, ri) {
  const c = getTrackColor(track);
  const act = track.activity || 'Otro';
  const ibp = ibpForTrackV(track), li = ibpLevelIdxV(ibp);
  const ibpHtml = li >= 0
    ? `<span class="ti-ibp" style="color:${IBP_LEVELS[li].color};background:${IBP_LEVELS[li].bg};border-color:${IBP_LEVELS[li].border}" title="IBP ${Math.round(ibp)} · ${IBP_LEVELS[li].label}">${IBP_LEVELS[li].label}</span>`
    : '';
  const meta = [track.sierra || track.zone].filter(Boolean).map(escHtml).join(' · ');
  const photo = ACT_PHOTOS[act];
  const photoHtml = photo
    ? `<div class="ti-photo" style="background-image:url('${photo}')"></div>`
    : `<div class="ti-photo ti-photo-empty"></div>`;
  const owner = track.owner_username
    ? `<span class="ti-owner" title="Propietario">${escHtml(track.owner_username)}</span>` : '';
  const detail = track.id
    ? `<a class="track-detail-link" href="/track?id=${track.id}" target="_blank" title="Abrir página de detalle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>` : '';
  return `<div class="track-item${ri === activeIdx ? ' active' : ''}" data-idx="${ri}" style="--c:${c}">
    <div class="ti-main">
      <div class="ti-top">
        <button class="ti-icon" title="Cambiar color de la ruta">${actIconInner(act)}</button>
        <div class="ti-name">${escHtml(track.name)}</div>
      </div>
      <div class="ti-meta"><span class="ti-act">${escHtml(track.activity || 'Sin actividad')}</span>${meta ? ' · ' + meta : ''}</div>
      <div class="ti-stats">
        <span><b>${nf1.format(track.distance)}</b> km</span>
        <span>↑ <b>${nf0.format(track.elevationGain)}</b> m</span>
        <span class="ti-rtype" title="${track.circular ? 'Circular' : 'Lineal'}">${track.circular ? ROUTE_ICON.loop : ROUTE_ICON.line}</span>
        ${ibpHtml}
      </div>
    </div>
    <div class="ti-side">
      <div class="ti-side-top">${detail}${owner}</div>
      ${photoHtml}
    </div>
  </div>`;
}

const ROUTE_ICON = {
  loop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
  line: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="4" cy="12" r="2"/><circle cx="20" cy="12" r="2"/><line x1="6.5" y1="12" x2="17.5" y2="12"/></svg>',
};
let _listKey = '';
const PAGE_SIZE = 15;
let _listPage = 0;

function renderList(force) {
  const list = $('tracklist');
  const pagesEl = $('tracklist-pages');
  const visible = items.map((it, ri) => ({ it, ri })).filter(x => x.it.visible);
  const key = sortMode + '|' + activeIdx + '|' + visible.map(x => x.ri).join(',');
  if (!force && key === _listKey) return;
  _listKey = key;
  _listPage = Math.min(_listPage, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1));
  if (!visible.length) {
    list.innerHTML = '<div class="empty-state">Ninguna ruta en esta zona<p>Mueve el mapa o quita algún filtro.</p></div>';
    pagesEl.innerHTML = '';
    return;
  }
  const cmp = SORTERS[sortMode] || SORTERS.name;
  visible.sort((a, b) => cmp(a.it.track, b.it.track));
  const pages = Math.ceil(visible.length / PAGE_SIZE);
  const start = _listPage * PAGE_SIZE;
  list.innerHTML = visible.slice(start, start + PAGE_SIZE).map(x => trackItemHtml(x.it.track, x.ri)).join('');
  if (pages <= 1) { pagesEl.innerHTML = ''; return; }
  // Build: 1 2 3 … N  (show neighbours of current page + first/last)
  const show = new Set([0, pages - 1, _listPage, _listPage - 1, _listPage + 1].filter(n => n >= 0 && n < pages));
  const btns = [];
  for (let i = 0; i < pages; i++) {
    if (show.has(i)) {
      btns.push(`<button class="page-btn${i === _listPage ? ' active' : ''}" data-p="${i}">${i + 1}</button>`);
    } else if (btns.at(-1) !== '<span class="page-btn page-ellipsis">…</span>') {
      btns.push('<span class="page-btn page-ellipsis">…</span>');
    }
  }
  pagesEl.innerHTML = btns.join('');
}

function goToPage(p) { _listPage = p; _listKey = ''; renderList(); }

const tracklistEl = $('tracklist');
tracklistEl.addEventListener('click', e => {
  const item = e.target.closest('.track-item'); if (!item) return;
  if (e.target.closest('.track-detail-link')) return;
  const idx = +item.dataset.idx;
  if (e.target.closest('.ti-icon')) {
    const track = items[idx].track;
    pickColor(getTrackColor(track), c => setTrackColor(track, c, false), c => setTrackColor(track, c, true));
    return;
  }
  activateTrack(idx, true);
});
$('tracklist-pages').addEventListener('click', e => {
  const btn = e.target.closest('.page-btn[data-p]');
  if (btn) goToPage(+btn.dataset.p);
});

let hoveredIdx = null;
tracklistEl.addEventListener('mouseover', e => {
  const item = e.target.closest('.track-item');
  const idx = item ? +item.dataset.idx : null;
  if (idx === hoveredIdx) return;
  if (hoveredIdx !== null) previewTrack(hoveredIdx, false);
  hoveredIdx = idx;
  if (idx !== null) previewTrack(idx, true);
});
tracklistEl.addEventListener('mouseleave', () => {
  if (hoveredIdx !== null) previewTrack(hoveredIdx, false);
  hoveredIdx = null;
});

$('sort-select').value = SORTERS[sortMode] ? sortMode : 'name';
$('sort-select').addEventListener('change', e => {
  sortMode = e.target.value;
  try { localStorage.setItem('visor-sort', sortMode); } catch {}
  _listPage = 0; renderList();
});

// ── Cascading pill counts ────────────────────────────────────────────
function updateFilterCounts(f) {
  const base = CATALOG.filter(t => baseMatch(t, f));
  const actCounts = {}, sierraCounts = {}, tagCounts = {};
  base.forEach(t => {
    if (sierraOk(t, f) && tagsOk(t, f)) { const a = t.activity || 'Sin clasificar'; actCounts[a] = (actCounts[a] || 0) + 1; }
    if (actOk(t, f) && tagsOk(t, f) && t.sierra) sierraCounts[t.sierra] = (sierraCounts[t.sierra] || 0) + 1;
    if (actOk(t, f) && sierraOk(t, f)) (t.tags || []).forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
  });
  const upd = (sel, key, counts, active) => $$(sel).forEach(pill => {
    const v = pill.dataset[key], n = counts[v] || 0;
    const c = pill.querySelector('.cat-count'); if (c) c.textContent = n;
    pill.classList.toggle('pill-empty', n === 0 && !active.has(v));
  });
  upd('#cat-filters .cat-pill', 'activity', actCounts, f.acts);
  upd('#sierra-filters .cat-pill', 'sierra', sierraCounts, f.sierras);
  upd('#tag-filters .cat-pill', 'tag', tagCounts, f.tags);
}

// ── Chip labels ──────────────────────────────────────────────────────
function setChip(pop, text, active) {
  const chip = document.querySelector(`.chip[data-pop="${pop}"]`); if (!chip) return;
  const lbl = chip.querySelector('.chip-lbl');
  lbl.textContent = text || lbl.dataset.default;
  chip.classList.toggle('active', !!active);
}
function multiLabel(set, plural, fmt) {
  if (set.size === 0) return '';
  if (set.size === 1) return fmt([...set][0]);
  return `${plural} · ${set.size}`;
}
function updateChips(f) {
  setChip('act',    multiLabel(f.acts, 'Actividades', v => v), f.acts.size);
  setChip('sierra', multiLabel(f.sierras, 'Zonas', v => v), f.sierras.size);
  setChip('dist',   sliders.dist?.summary(), sliders.dist?.isActive());
  setChip('ele',    sliders.ele?.summary() && `↑ ${sliders.ele.summary()}`, sliders.ele?.isActive());
  setChip('ibp',    f.ibpActive ? $('ibp-rs-label').textContent : '', f.ibpActive);
  const more = [];
  if (f.rtype.has('circular')) more.push('Circular');
  if (f.rtype.has('lineal'))   more.push('Lineal');
  if (f.year) more.push(f.year);
  if (f.tags.size) more.push(f.tags.size === 1 ? '#' + [...f.tags][0] : `${f.tags.size} etiquetas`);
  setChip('more', more.join(' · '), more.length);
  if (f.owner != null) {
    const ownerName = f.owner === gCurrentUser?.id ? 'Mis rutas'
      : (CATALOG.find(t => t.owner_id === f.owner)?.owner_username || 'Usuario');
    setChip('owner', ownerName, true);
  } else setChip('owner', '', false);
  $('clear-filters-btn').hidden = countActiveFilters(f) === 0;
}
function countActiveFilters(f) {
  return f.acts.size + f.sierras.size + f.tags.size + f.rtype.size +
    (f.ibpActive ? 1 : 0) + (geoFilter ? 1 : 0) +
    (sliders.dist?.isActive() ? 1 : 0) + (sliders.ele?.isActive() ? 1 : 0) +
    (f.year ? 1 : 0) + (f.q ? 1 : 0) + (f.owner != null ? 1 : 0);
}

// ── Build filter UI ──────────────────────────────────────────────────
function buildFilters() {
  const acts = {};
  CATALOG.forEach(t => { const a = t.activity || 'Sin clasificar'; acts[a] = (acts[a] || 0) + 1; });
  $('cat-filters').innerHTML = Object.keys(acts).sort((a, b) => a.localeCompare(b, 'es')).map(act => {
    const c = actColor(act);
    return `<div class="cat-pill" data-activity="${escHtml(act)}"><span class="cat-dot" title="Cambiar color" style="background:${c}"></span>${escHtml(act)}<span class="cat-count">${acts[act]}</span></div>`;
  }).join('');
  $('cat-filters').addEventListener('click', e => {
    const pill = e.target.closest('.cat-pill'); if (!pill) return;
    if (e.target.closest('.cat-dot')) {
      const act = pill.dataset.activity;
      pickColor(actColor(act), c => setActivityColor(act, c, false), c => setActivityColor(act, c, true));
      return;
    }
    pill.classList.toggle('active'); applyFilters();
  });

  const sierras = {};
  CATALOG.forEach(t => { if (t.sierra) sierras[t.sierra] = (sierras[t.sierra] || 0) + 1; });
  if (Object.keys(sierras).length) {
    $('chip-sierra').hidden = false;
    $('sierra-filters').innerHTML = Object.keys(sierras).sort((a, b) => a.localeCompare(b, 'es')).map(s =>
      `<div class="cat-pill" data-sierra="${escHtml(s)}">${escHtml(s)}<span class="cat-count">${sierras[s]}</span></div>`).join('');
  }

  // Chip "Mis rutas" + selector de propietario (solo si hay sesión)
  if (gCurrentUser) {
    $('chip-my-tracks').hidden = false;
    // Propietarios distintos presentes en el catálogo
    const owners = new Map();  // id → username
    CATALOG.forEach(t => { if (t.owner_id && t.owner_username) owners.set(t.owner_id, t.owner_username); });
    const mine = gCurrentUser.id;
    const others = [...owners.entries()].filter(([id]) => id !== mine).sort((a, b) => a[1].localeCompare(b[1], 'es'));
    const pills = [`<div class="cat-pill" data-owner="${mine}">Mis rutas<span class="cat-count">${CATALOG.filter(t => t.owner_id === mine).length}</span></div>`];
    others.forEach(([id, name]) => pills.push(`<div class="cat-pill" data-owner="${id}">${escHtml(name)}<span class="cat-count">${CATALOG.filter(t => t.owner_id === id).length}</span></div>`));
    $('owner-filters').innerHTML = pills.join('');
    $('owner-filters').addEventListener('click', e => {
      const pill = e.target.closest('.cat-pill'); if (!pill) return;
      const id = +pill.dataset.owner;
      gOwnerFilter = (gOwnerFilter === id) ? null : id;   // volver a pulsar = quitar filtro
      $$('#owner-filters .cat-pill').forEach(p => p.classList.toggle('active', +p.dataset.owner === gOwnerFilter));
      applyFilters();
    });
  }

  const tagMap = {};
  CATALOG.forEach(t => (t.tags || []).forEach(tag => { tagMap[tag] = (tagMap[tag] || 0) + 1; }));
  if (Object.keys(tagMap).length) {
    $('tags-section-title').hidden = false;
    $('tag-filters').innerHTML = Object.keys(tagMap).sort((a, b) => a.localeCompare(b, 'es')).map(tag =>
      `<div class="cat-pill" data-tag="${escHtml(tag)}">#${escHtml(tag)}<span class="cat-count">${tagMap[tag]}</span></div>`).join('');
  }

  ['sierra-filters','tag-filters','route-type-filters'].forEach(id => $(id).addEventListener('click', e => {
    const pill = e.target.closest('.cat-pill'); if (!pill) return;
    pill.classList.toggle('active'); applyFilters();
  }));

  const years = [...new Set(CATALOG.map(t => t.date ? t.date.substring(0,4) : null).filter(Boolean))].sort().reverse();
  years.forEach(y => { const o = document.createElement('option'); o.value = o.textContent = y; $('year-filter').appendChild(o); });
  $('year-filter').addEventListener('change', applyFilters);

  ['ibp-rs-min','ibp-rs-max'].forEach(id => $(id).addEventListener('input', () => {
    let mn = parseInt($('ibp-rs-min').value), mx = parseInt($('ibp-rs-max').value);
    if (mn > mx) { if (id === 'ibp-rs-min') mn = mx; else mx = mn; }
    $('ibp-rs-min').value = mn; $('ibp-rs-max').value = mx;
    updateIbpSlider(); applyFilters();
  }));
  updateIbpSlider();

  $('geo-radius').addEventListener('click', e => {
    const pill = e.target.closest('.cat-pill'); if (!pill) return;
    $$('#geo-radius .cat-pill').forEach(p => p.classList.toggle('active', p === pill));
    if (!geoFilter) return;
    geoFilter.radius = parseInt(pill.dataset.r);
    drawGeo(true);
    applyFilters();
  });

  const maxDist = Math.max(Math.ceil(Math.max(...CATALOG.map(t => t.distance || 0)) / 10) * 10, 50);
  const maxEle  = Math.max(Math.ceil(Math.max(...CATALOG.map(t => t.elevationGain || 0)) / 500) * 500, 1000);
  sliders.dist = initDualSlider('dist-rs-min','dist-rs-max','dist-rs-fill','dist-rs-label', 0, maxDist, 5, 'km', applyFilters);
  sliders.ele  = initDualSlider('ele-rs-min', 'ele-rs-max', 'ele-rs-fill', 'ele-rs-label',  0, maxEle, 100, 'm', applyFilters);
}

function updateIbpSlider() {
  const minV = parseInt($('ibp-rs-min').value), maxV = parseInt($('ibp-rs-max').value);
  const pct = i => (i / 5) * 100;
  const fill = $('ibp-rs-fill');
  fill.style.left = pct(minV) + '%';
  fill.style.width = (pct(maxV) - pct(minV)) + '%';
  $$('#ibp-dots-row .ibp-dot').forEach(d => {
    const i = parseInt(d.dataset.i);
    d.classList.toggle('in-range', i >= minV && i <= maxV);
  });
  $('ibp-rs-label').textContent = (minV === 0 && maxV === 5) ? 'Cualquiera'
    : minV === maxV ? IBP_LEVELS[minV].label
    : `${IBP_LEVELS[minV].label} → ${IBP_LEVELS[maxV].label}`;
}

// ── Reset helpers ────────────────────────────────────────────────────
const RESETS = {
  act:    () => $$('#cat-filters .cat-pill.active').forEach(p => p.classList.remove('active')),
  sierra: () => $$('#sierra-filters .cat-pill.active').forEach(p => p.classList.remove('active')),
  tags:   () => $$('#tag-filters .cat-pill.active').forEach(p => p.classList.remove('active')),
  dist:   () => sliders.dist.reset(),
  ele:    () => sliders.ele.reset(),
  ibp:    () => { $('ibp-rs-min').value = 0; $('ibp-rs-max').value = 5; updateIbpSlider(); },
  more:   () => { $$('#route-type-filters .cat-pill.active, #tag-filters .cat-pill.active').forEach(p => p.classList.remove('active')); $('year-filter').value = ''; },
  owner:  () => { gOwnerFilter = null; $$('#owner-filters .cat-pill.active').forEach(p => p.classList.remove('active')); },
  geo:    () => clearGeoFilter(),
};
$$('.pop-reset').forEach(btn => btn.addEventListener('click', () => { RESETS[btn.dataset.reset](); applyFilters(); }));
$('clear-filters-btn').addEventListener('click', () => {
  Object.values(RESETS).forEach(fn => fn());
  $('text-search').value = '';
  $('search-clear').hidden = true;
  closePopover();
  applyFilters();
});

// ── Popovers ─────────────────────────────────────────────────────────
let openPop = null;
function closePopover() {
  if (!openPop) return;
  openPop.pop.classList.remove('open');
  openPop.chip.classList.remove('open');
  openPop = null;
}
function positionPopover(pop, chip) {
  const r = chip.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top  = (r.bottom + 8) + 'px';
  pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
}
$$('#chips .chip[data-pop]').forEach(chip => chip.addEventListener('click', e => {
  e.stopPropagation();
  const pop = $('pop-' + chip.dataset.pop);
  if (openPop?.pop === pop) { closePopover(); return; }
  closePopover();
  closeSearch();
  pop.classList.add('open'); chip.classList.add('open');
  positionPopover(pop, chip);
  openPop = { pop, chip };
}));
document.addEventListener('mousedown', e => {
  if (openPop && !openPop.pop.contains(e.target) && !openPop.chip.contains(e.target)) closePopover();
});
$('chips').addEventListener('scroll', () => { if (openPop) positionPopover(openPop.pop, openPop.chip); });


// ── Unified search: routes + places ──────────────────────────────────
const searchInp = $('text-search');
const resultsEl = $('search-results');
let searchFocus = -1;
let placeSeq = 0, placeTimer = null, placeResults = [];

function closeSearch() { resultsEl.classList.remove('open'); searchFocus = -1; }

function highlight(name, q) {
  const n = norm(name), i = n.indexOf(q);
  if (!q || i < 0) return escHtml(name);
  return escHtml(name.slice(0, i)) + '<mark>' + escHtml(name.slice(i, i + q.length)) + '</mark>' + escHtml(name.slice(i + q.length));
}

function renderSearchResults() {
  const raw = searchInp.value.trim();
  const q = norm(raw);
  if (!q) { closeSearch(); return; }
  const routes = items.map((it, i) => ({ t: it.track, i })).filter(x => x.t._q.includes(q))
    .sort((a, b) => (norm(a.t.name).startsWith(q) ? 0 : 1) - (norm(b.t.name).startsWith(q) ? 0 : 1) || a.t.name.localeCompare(b.t.name, 'es'))
    .slice(0, 6);
  let html = `<div class="dd-sec">Rutas</div>`;
  html += routes.length ? routes.map(({ t, i }) => {
    const c = getTrackColor(t);
    return `<div class="dd-item" data-kind="route" data-idx="${i}">
      <span class="dd-ico act" style="background:${c}">${actIconInner(t.activity || 'Otro')}</span>
      <div class="dd-txt"><div class="dd-name">${highlight(t.name, q)}</div>
      <div class="dd-meta">${escHtml(t.activity || 'Sin actividad')} · ${nf1.format(t.distance)} km · ↑ ${nf0.format(t.elevationGain)} m</div></div></div>`;
  }).join('') : `<div class="dd-empty">Ninguna ruta con ese nombre</div>`;
  html += `<div class="dd-sec">Lugares</div>`;
  if (raw.length < 3) html += `<div class="dd-empty">Escribe al menos 3 letras para buscar lugares</div>`;
  else if (!placeResults.length) html += `<div class="dd-empty">Buscando lugares…</div>`;
  else html += placeResults.map((p, k) => `<div class="dd-item" data-kind="place" data-k="${k}">
      <span class="dd-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></span>
      <div class="dd-txt"><div class="dd-name">${escHtml(p.display_name.split(',')[0])}</div>
      <div class="dd-meta">${escHtml(p.display_name.split(',').slice(1).join(',').trim())}</div></div></div>`).join('');
  resultsEl.innerHTML = html;
  resultsEl.classList.add('open');
  searchFocus = -1;
}

function queryPlaces() {
  clearTimeout(placeTimer);
  const raw = searchInp.value.trim();
  placeResults = [];
  if (raw.length < 3) return;
  const seq = ++placeSeq;
  placeTimer = setTimeout(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(raw)}&format=json&limit=5&accept-language=es`;
      const data = await (await fetch(url)).json();
      if (seq !== placeSeq) return;
      placeResults = data;
      if (document.activeElement === searchInp) renderSearchResults();
    } catch {}
  }, 400);
}

function chooseResult(el) {
  if (el.dataset.kind === 'route') {
    const idx = +el.dataset.idx;
    searchInp.value = ''; $('search-clear').hidden = true;
    closeSearch(); searchInp.blur();
    applyFilters();
    activateTrack(idx, true);
  } else {
    const p = placeResults[+el.dataset.k];
    searchInp.value = ''; $('search-clear').hidden = true;
    closeSearch(); searchInp.blur();
    setGeo(parseFloat(p.lat), parseFloat(p.lon), p.display_name);
  }
}

let searchApplyTimer = null;
searchInp.addEventListener('input', () => {
  $('search-clear').hidden = !searchInp.value;
  renderSearchResults();
  queryPlaces();
  clearTimeout(searchApplyTimer);
  searchApplyTimer = setTimeout(applyFilters, 120);
});
searchInp.addEventListener('focus', () => { closePopover(); if (searchInp.value.trim()) renderSearchResults(); });
searchInp.addEventListener('blur', () => setTimeout(closeSearch, 150));
searchInp.addEventListener('keydown', e => {
  const list = [...resultsEl.querySelectorAll('.dd-item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!list.length) return;
    e.preventDefault();
    searchFocus = e.key === 'ArrowDown' ? Math.min(searchFocus + 1, list.length - 1) : Math.max(searchFocus - 1, 0);
    list.forEach((el, k) => el.classList.toggle('focused', k === searchFocus));
    list[searchFocus].scrollIntoView({ block:'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchFocus >= 0 && list[searchFocus]) chooseResult(list[searchFocus]);
    else { closeSearch(); applyFilters(); }
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    if (resultsEl.classList.contains('open')) closeSearch();
    else { searchInp.value = ''; $('search-clear').hidden = true; applyFilters(); }
  }
});
resultsEl.addEventListener('mousedown', e => {
  const el = e.target.closest('.dd-item'); if (!el) return;
  e.preventDefault();
  chooseResult(el);
});
$('search-clear').addEventListener('click', () => {
  searchInp.value = ''; $('search-clear').hidden = true;
  closeSearch(); applyFilters(); searchInp.focus();
});

// ── Panel collapse ───────────────────────────────────────────────────
function setPanelCollapsed(c) {
  $('app').classList.toggle('panel-collapsed', c);
  $('panel-toggle').title = c ? 'Mostrar lista' : 'Plegar lista';
  try { localStorage.setItem('visor-panel-collapsed', c ? '1' : '0'); } catch {}
}
$('panel-toggle').addEventListener('click', () => setPanelCollapsed(!$('app').classList.contains('panel-collapsed')));
$('list-count').addEventListener('click', () => { if ($('app').classList.contains('panel-collapsed')) setPanelCollapsed(false); });
try { if (localStorage.getItem('visor-panel-collapsed') === '1') setPanelCollapsed(true); } catch {}

// ── Redimensionar panel (arrastrar el borde derecho) ──────────────────
const PANEL_MIN = 320, PANEL_MAX = 680;
function setPanelWidth(px) {
  const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, px));
  document.documentElement.style.setProperty('--panel-w', w + 'px');
  try { localStorage.setItem('visor-panel-w', String(w)); } catch {}
  return w;
}
try { const saved = parseInt(localStorage.getItem('visor-panel-w')); if (saved) setPanelWidth(saved); } catch {}

(() => {
  const handle = $('panel-resize');
  if (!handle) return;
  const onMove = e => {
    const panelLeft = $('panel').getBoundingClientRect().left;
    setPanelWidth(e.clientX - panelLeft);
  };
  const onUp = () => {
    document.body.classList.remove('panel-resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (activeIdx !== null) { const t = items[activeIdx].track; showProfile(t, getTrackColor(t)); }
  };
  handle.addEventListener('mousedown', e => {
    if (window.matchMedia('(max-width: 760px)').matches) return;
    e.preventDefault();
    document.body.classList.add('panel-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
})();

// ── Global keys / resize ─────────────────────────────────────────────
$('profile-close').addEventListener('click', deactivateTrack);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (openPop) { closePopover(); return; }
  if (activeIdx !== null && document.activeElement !== searchInp) deactivateTrack();
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  closePopover();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (activeIdx !== null) { const t = items[activeIdx].track; showProfile(t, getTrackColor(t)); }
  }, 200);
});

// ── Init ─────────────────────────────────────────────────────────────
buildFilters();
applyFilters();
if (CATALOG.length > 0) fitTo(L.latLngBounds(coreBounds(CATALOG)), 12);

// Fit to where most tracks are, so a handful of far-away outliers don't zoom the map out to a continent.
function coreBounds(tracks) {
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const c = L.latLng(med(tracks.map(t => t.center[0])), med(tracks.map(t => t.center[1])));
  const core = tracks.filter(t => c.distanceTo(t.center) < 700000);
  return (core.length >= tracks.length * 0.6 ? core : tracks).flatMap(t => t.bounds);
}

const _openFile = new URLSearchParams(location.search).get('file');
if (_openFile) {
  const _idx = items.findIndex(it => it.track.file === _openFile);
  if (_idx >= 0) setTimeout(() => activateTrack(_idx, true), 400);
}
const _openId = new URLSearchParams(location.search).get('id');
if (_openId) {
  const _idx2 = items.findIndex(it => it.track.id === +_openId);
  if (_idx2 >= 0) setTimeout(() => activateTrack(_idx2, true), 600);
}

const _openIds = new URLSearchParams(location.search).get('ids');
if (_openIds) {
  _openIds.split(',').map(Number).filter(Boolean).forEach(id => idSet.add(id));
  applyFilters();
  const idBounds = items.filter(it => idSet.has(it.track.id)).flatMap(it => it.track.bounds);
  if (idBounds.length) fitTo(L.latLngBounds(idBounds), 12);
}

})();
