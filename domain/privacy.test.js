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

test('privacyZones: for every seed the disc of the radius around the real start/end is inside the zone', () => {
  const R = 500, [s0] = [line[0]];
  for (let seed = 1; seed <= 3000; seed++) {
    const [z] = privacyZones(line, R, seed);
    for (let a = 0; a < 360; a += 15) {   // points exactly R metres from the real point, in every direction
      const lat = s0[0] + (R * Math.cos(a * Math.PI / 180)) / 111320;
      const lon = s0[1] + (R * Math.sin(a * Math.PI / 180)) / (111320 * Math.cos(s0[0] * Math.PI / 180));
      assert.ok(havM(lat, lon, z.lat, z.lon) <= z.r + 0.5, `seed ${seed}, angle ${a}`);
    }
  }
});
