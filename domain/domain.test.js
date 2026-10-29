'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('./index');

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Wikiloc - Ruta &amp; Prueba</name><link href="https://example.com/r/1"/><time>2024-05-01T08:00:00Z</time></metadata>
  <wpt lat="40.0005" lon="-3.7"><ele>1010</ele><name>Fuente &lt;vieja&gt;</name><sym>Water</sym></wpt>
  <trk><name>Cuerda &amp; Collado</name><trkseg>
    <trkpt lat="40.000" lon="-3.700"><ele>1000</ele><time>2024-05-01T08:00:00Z</time></trkpt>
    <trkpt lat="40.005" lon="-3.700"><ele>1005</ele><time>2024-05-01T08:05:00Z</time></trkpt>
    <trkpt lat="40.010" lon="-3.700"><ele>1020</ele><time>2024-05-01T08:10:00Z</time></trkpt>
    <trkpt lat="40.010" lon="-3.700"><ele>1020</ele><time>2024-05-01T08:15:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

test('parseGpx: name, url, date, points and waypoints', () => {
  const p = d.parseGpx(GPX, { fileName: 'C:\\x\\algo.gpx' });
  assert.equal(p.name, 'Cuerda & Collado');
  assert.equal(p.url, 'https://example.com/r/1');
  assert.equal(p.date, '2024-05-01');
  assert.equal(p.points.length, 4);
  assert.deepEqual(p.points[0], { lat: 40, lon: -3.7, ele: 1000, time: Date.parse('2024-05-01T08:00:00Z') });
  assert.deepEqual(p.waypoints, [{ lat: 40.0005, lon: -3.7, ele: 1010, name: 'Fuente <vieja>', sym: 'Water', desc: null }]);
});

test('parseGpx: falls back to metadata name (without "Wikiloc - ") and to the file-name date', () => {
  const gpx = '<gpx><metadata><name>Wikiloc - Pico</name></metadata><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2"/></trkseg></trk></gpx>';
  const p = d.parseGpx(gpx, { fileName: '/tmp/2023-07-09_pico.gpx' });
  assert.equal(p.name, 'Pico');
  assert.equal(p.date, '2023-07-09');
  assert.equal(p.points[0].ele, null);
  assert.equal(p.points[0].time, null);
});

test('computeMetrics: distance, noise-filtered elevation, bounds and circularity', () => {
  const m = d.computeMetrics(d.parseGpx(GPX).points);
  assert.equal(m.distance, 1.1);          // 0.01° of latitude ≈ 1.11 km
  assert.equal(m.elevationGain, 20);      // +5 is below the 8 m noise threshold, then +20 from 1000
  assert.equal(m.elevationLoss, 0);
  assert.equal(m.minElevation, 1000);
  assert.equal(m.maxElevation, 1020);
  assert.deepEqual([m.swLat, m.neLat, m.swLon, m.neLon], [40, 40.01, -3.7, -3.7]);
  assert.equal(m.circular, 0);
  assert.equal(d.computeMetrics([{ lat: 1, lon: 1 }]), null);
  const loop = [{ lat: 40, lon: -3.7 }, { lat: 40.01, lon: -3.7 }, { lat: 40.0001, lon: -3.7 }];
  assert.equal(d.computeMetrics(loop).circular, 1);
});

test('computeTimes: moving vs stopped, long gaps ignored', () => {
  assert.deepEqual(d.computeTimes(d.parseGpx(GPX).points), { moving: 600, stopped: 300 });
  const gap = [{ lat: 0, lon: 0, time: 0 }, { lat: 0.01, lon: 0, time: 3600e3 }];
  assert.equal(d.computeTimes(gap), null);
  assert.equal(d.computeTimes([{ lat: 0, lon: 0, time: null }]), null);
});

test('inferActivity: keywords first, then distance and climb per km', () => {
  assert.deepEqual(d.inferActivity('Vuelta en MTB', 30, 500), { act: 'MTB', conf: 'high' });
  assert.deepEqual(d.inferActivity('Camino del agua', 10, 100), { act: 'Senderismo', conf: 'high' });
  assert.deepEqual(d.inferActivity('Ruta', 120, 1000), { act: 'Ciclismo de carretera', conf: 'medium' });
  assert.deepEqual(d.inferActivity('Ruta', 25, 2000), { act: 'Trail Running', conf: 'medium' });
  assert.deepEqual(d.inferActivity('Ruta', 8, 100), { act: 'Senderismo', conf: 'low' });
});

test('zones: bbox lookup and Nominatim parsing', () => {
  const sierras = [{ name: 'Guadarrama', sw: [40.6, -4.2], ne: [41, -3.7] }];
  assert.equal(d.sierraFromBbox(40.8, -3.9, sierras), 'Guadarrama');
  assert.equal(d.sierraFromBbox(39, -3.9, sierras), null);
  const geo = { display_name: 'Cercedilla, Sierra de Guadarrama, Madrid', address: { county: 'Provincia de Madrid', state: 'Comunidad de Madrid' } };
  assert.equal(d.extractSierraFromNominatim(geo), 'Sierra de Guadarrama');
  assert.deepEqual(d.locationFromNominatim(geo), { province: 'Madrid', ccaa: 'Comunidad de Madrid' });
});

test('computeIBP', () => {
  assert.deepEqual(d.computeIBP(10, 1000), { ibp_hiking: 77, ibp_bicycle: 76, ibp_running: 170 });
});

test('cleaning: spikes, minimum distance and RDP', () => {
  const line = [0, 1, 2, 3, 4].map(i => ({ lat: 40 + i * 0.001, lon: -3.7 }));
  const spike = [line[0], line[1], { lat: 40.002, lon: -3.69 }, line[3], line[4]];
  assert.equal(d.filterMaxJump(spike, 100).length, 4);
  const dense = [line[0], { lat: 40.00001, lon: -3.7 }, line[1]];
  assert.equal(d.filterMinDist(dense, 5).length, 2);
  assert.equal(d.rdpSimplify(line, 1).length, 2);  // collinear → only the ends survive
  assert.equal(d.cleanPoints(spike, { maxJump: 100, rdp: 1 }).length, 2);
  assert.equal(d.cleanPoints(line).length, 5);     // no filters enabled
});

test('sampleEvenly', () => {
  const pts = Array.from({ length: 11 }, (_, i) => ({ lat: i, lon: 0, ele: i * 10.4 }));
  assert.deepEqual(d.sampleEvenly(pts, 3).map(p => p.lat), [0, 5, 10]);
  assert.equal(d.sampleEvenly(pts, 50), pts);
});

test('applyGpxMetadata rewrites the track header and escapes values', () => {
  const out = d.applyGpxMetadata(GPX, d.metaFromTrack({ name: 'Nuevo <nombre>', activity: 'MTB', notes: null, url: 'https://x.y/?a=1&b=2' }));
  const p = d.parseGpx(out);
  assert.equal(p.name, 'Nuevo <nombre>');
  assert.match(out, /<type>MTB<\/type>/);
  assert.match(out, /<link href="https:\/\/x\.y\/\?a=1&amp;b=2"\/>/);
  assert.doesNotMatch(out, /<desc>/);
  assert.equal(d.applyGpxMetadata('<gpx/>', { name: 'x' }), '<gpx/>');
});

test('buildGpx round-trips through parseGpx', () => {
  const xml = d.buildGpx([{ name: 'A & B', date: '2024-01-02', pts: [{ lat: 1, lon: 2, ele: 3 }, { lat: 1.1, lon: 2, ele: null }] }]);
  const p = d.parseGpx(xml);
  assert.equal(p.name, 'A & B');
  assert.deepEqual(p.points.map(q => [q.lat, q.lon, q.ele]), [[1, 2, 3], [1.1, 2, null]]);
});
