'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG, mergeConfig, validateConfig, multiDayInfo, computeAchievements } = require('./gamification');

const cfg = mergeConfig(null);
const T = (o) => ({ name: 'Ruta', activity: 'Senderismo', distance: 10, elevation_gain: 500, moving_time: null,
                    province: 'Madrid', circular: 0, date: '2024-05-01', ...o });

test('multiDayInfo: a normal day hike is not multi-day', () => {
  const r = multiDayInfo(T({ distance: 29, elevation_gain: 2481 }), cfg);   // ≈11.4 h estimated
  assert.equal(r.multiDay, false);
});

test('multiDayInfo: long foot route by distance and ascent', () => {
  const r = multiDayInfo(T({ activity: 'Montañismo', distance: 151.4, elevation_gain: 12078 }), cfg);
  assert.equal(r.multiDay, true);
  assert.equal(r.reason, 'distancia y desnivel');
  assert.ok(r.estDays >= 2);
});

test('multiDayInfo: bike pace differs from foot pace', () => {
  assert.equal(multiDayInfo(T({ activity: 'MTB', distance: 103, elevation_gain: 1600 }), cfg).multiDay, false);
  assert.equal(multiDayInfo(T({ activity: 'MTB', distance: 249, elevation_gain: 4579 }), cfg).multiDay, true);
  assert.equal(multiDayInfo(T({ activity: 'Ciclismo de carretera', distance: 305, elevation_gain: 794 }), cfg).multiDay, true);
});

test('multiDayInfo: measured moving time and name keywords', () => {
  assert.equal(multiDayInfo(T({ activity: 'MTB', distance: 80, moving_time: 14 * 3600 }), cfg).reason, 'tiempo en movimiento');
  assert.equal(multiDayInfo(T({ name: 'Ruta circular Vignemale en tres etapas' }), cfg).reason, 'nombre');
  assert.equal(multiDayInfo(T({ name: '4 Etapa Pedals De Foc. Espot- Vielha' }), cfg).multiDay, false);   // one stage = one day
  assert.equal(multiDayInfo(T({ name: 'Transgredos en bicicleta (4 etapas)' }), cfg).reason, 'nombre');
  assert.equal(multiDayInfo(T({ name: 'Travesia de 3 dias por Picos' }), cfg).reason, 'nombre');
});

test('multiDayInfo: disabled detection never flags', () => {
  const off = mergeConfig({ multiDay: { enabled: false } });
  assert.equal(multiDayInfo(T({ distance: 500, elevation_gain: 9000 }), off).multiDay, false);
});

test('computeAchievements: multi-day excluded from records but kept in totals', () => {
  const tracks = [T({ id: 1, distance: 20, elevation_gain: 1000 }), T({ id: 2, activity: 'Montañismo', distance: 151.4, elevation_gain: 12078 })];
  const r = computeAchievements(tracks, { photos: 0, lists: 0 }, cfg);
  const by = id => r.achievements.find(a => a.id === id);
  assert.equal(by('max_km').value, 20);
  assert.equal(by('max_gain').value, 1000);
  assert.equal(by('km').value, 171);
  assert.equal(by('multiday').value, 1);
  assert.deepEqual(r.multiDayRoutes.map(m => m.id), [2]);
});

test('computeAchievements: excludeFromTotals and disabled families', () => {
  const c = mergeConfig({ multiDay: { excludeFromTotals: true }, families: [{ id: 'photos', enabled: false }] });
  const tracks = [T({ distance: 20 }), T({ activity: 'Montañismo', distance: 151.4, elevation_gain: 12078 })];
  const r = computeAchievements(tracks, {}, c);
  assert.equal(r.achievements.find(a => a.id === 'km').value, 20);
  assert.equal(r.achievements.find(a => a.id === 'photos'), undefined);
  assert.equal(r.total, (DEFAULT_CONFIG.families.length - 1) * 5);
});

test('computeAchievements: XP and level follow the configured weights', () => {
  const c = mergeConfig({ xp: { perKm: 2, gainPerXp: 100, perTier: 0, levelBase: 100 } });
  const r = computeAchievements([T({ distance: 50, elevation_gain: 1000 })], {}, c);
  assert.equal(r.xp, 110);         // 50·2 + 1000/100
  assert.equal(r.level, 2);        // floor(sqrt(110/100)) + 1
});

test('mergeConfig keeps defaults for missing or invalid values', () => {
  const c = mergeConfig({ xp: { perKm: 'x' }, families: [{ id: 'km', tiers: [1, 2] }, { id: 'nope', enabled: false }] });
  assert.equal(c.xp.perKm, DEFAULT_CONFIG.xp.perKm);
  assert.deepEqual(c.families.find(f => f.id === 'km').tiers, DEFAULT_CONFIG.families.find(f => f.id === 'km').tiers);
});

test('validateConfig rejects unordered tiers and bad regex', () => {
  assert.throws(() => validateConfig(mergeConfig({ families: [{ id: 'km', tiers: [5, 4, 3, 2, 1] }] })), /menor a mayor/);
  assert.throws(() => validateConfig(mergeConfig({ multiDay: { keywords: '(' } })), /expresión no válida/);
  assert.doesNotThrow(() => validateConfig(mergeConfig(null)));
});
