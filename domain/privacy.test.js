'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { privacyZones, privacyTrim, inZones } = require('./privacy');
const { havM } = require('./geo');

// A straight 5 km route northwards: one point every ~11 m
const line = Array.from({ length: 451 }, (_, i) => [40 + i * 0.0001, -3.7, 700]);

test('privacyTrim: radius 0 returns the same points', () => {
  assert.equal(privacyTrim(line, 0, 1), line);
});

test('privacyTrim: removes the points near the start and the end', () => {
  const out = privacyTrim(line, 300, 42);
  assert.ok(out.length < line.length && out.length > 300);
  const [s, e] = [line[0], line[line.length - 1]];
  for (const p of out) {
    assert.ok(havM(p[0], p[1], s[0], s[1]) > 300, 'nothing within the radius of the real start');
    assert.ok(havM(p[0], p[1], e[0], e[1]) > 300, 'nothing within the radius of the real end');
  }
});

test('privacyZones: zone contains the real point but is not centred on it', () => {
  const [z] = privacyZones(line, 300, 7);
  assert.ok(inZones(line[0][0], line[0][1], [z]));
  assert.ok(havM(z.lat, z.lon, line[0][0], line[0][1]) > 0);
  assert.ok(z.r >= 360 && z.r <= 450);
});

test('privacyZones: deterministic for the same seed, different for another', () => {
  assert.deepEqual(privacyZones(line, 300, 5), privacyZones(line, 300, 5));
  assert.notDeepEqual(privacyZones(line, 300, 5), privacyZones(line, 300, 6));
});

test('privacyTrim: works with {lat, lon} objects and can hide a short route entirely', () => {
  const pts = [{ lat: 40, lon: -3.7 }, { lat: 40.0005, lon: -3.7 }, { lat: 40.001, lon: -3.7 }];
  assert.equal(privacyTrim(pts, 500, 1).length, 0);
});
