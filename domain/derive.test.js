'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { visiblePoints, searchText, DERIVE_TOLERANCES } = require('./derive');
const { privacyZones, inZones } = require('./privacy');

const line = Array.from({ length: 451 }, (_, i) => ({ lat: 40 + i * 0.0001, lon: -3.7, ele: 700 }));

test('visiblePoints: radius 0 returns the same points', () => {
  assert.equal(visiblePoints(line, 0, 7), line);
});

test('visiblePoints: trims with a radius', () => {
  const out = visiblePoints(line, 300, 7);
  assert.ok(out.length < line.length && out.length > 300);
});

test('visiblePoints: a route entirely inside the zone is left empty', () => {
  const small = Array.from({ length: 20 }, (_, i) => ({ lat: 40 + i * 0.00005, lon: -3.7 }));
  assert.equal(visiblePoints(small, 500, 3).length, 0);
});

test('visiblePoints: identical to the phase-2 trim (applyPrivacy) for the same seed', () => {
  const zones = privacyZones(line, 250, 99);
  const expected = line.filter(p => !inZones(p.lat, p.lon, zones));
  assert.deepEqual(visiblePoints(line, 250, 99), expected);
});

test('searchText: lowercase, no accents, tags as JSON text or array', () => {
  assert.equal(searchText({ name: 'Ruta a Peñalara', sierra: 'Guadarrama', province: 'Segovia', tags: '["Circular","Niño"]' }),
    'ruta a penalara guadarrama segovia circular nino');
  assert.equal(searchText({ name: 'Ñandú', tags: ['A'] }), 'nandu a');
  assert.equal(searchText({}), '');
});

test('DERIVE_TOLERANCES', () => {
  assert.ok(DERIVE_TOLERANCES.s1 < DERIVE_TOLERANCES.s2);
});
