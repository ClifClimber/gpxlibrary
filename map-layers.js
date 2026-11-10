'use strict';
// Base maps shared by every page with a Leaflet map (visor, route, compare, draw, list, upload).
// Only sources that may be used by a public site with attribution: OpenStreetMap standard tiles (light use: for real
// traffic move to a tile provider with a key), OpenTopoMap, IGN España (CC BY 4.0, also the PNOA orthophoto instead of
// the Google satellite layers) and Stadia. CARTO's free raster tiles now require an API key, so they are not offered.
// Each call returns new layer objects (a Leaflet layer can only live on one map).
window.gpxBaseLayers = function () {
  const osm = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const ign = '© <a href="https://www.ign.es">IGN España</a>';
  const wmts = (layer, fmt) => `https://www.ign.es/wmts/${layer === 'MTN' ? 'mapa-raster' : 'pnoa-ma'}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&FORMAT=${fmt}&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
  return {
    'OpenStreetMap':      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: osm, maxZoom: 19 }),
    'OpenTopoMap':        L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { attribution: '© OpenTopoMap (CC-BY-SA) · ' + osm, maxZoom: 17 }),
    'IGN Topográfico':    L.tileLayer(wmts('MTN', 'image/jpeg'), { attribution: ign, maxZoom: 20 }),
    'IGN Satélite (PNOA)': L.tileLayer(wmts('OI.OrthoimageCoverage', 'image/jpeg'), { attribution: ign + ' · PNOA', maxZoom: 20 }),
    'Stadia Outdoors':    L.tileLayer('https://tiles.stadiamaps.com/tiles/outdoors/{z}/{x}/{y}{r}.png', { attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> ' + osm, maxZoom: 20 }),
  };
};
window.gpxDefaultBase = 'OpenStreetMap';
