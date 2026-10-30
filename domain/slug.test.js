'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('./slug');

test('slugify: accents, ñ, punctuation and spaces', () => {
  assert.equal(slugify('Peñalara por la Laguna Grande (2.428 m)'), 'penalara-por-la-laguna-grande-2-428-m');
  assert.equal(slugify('  ¡Ruta MTB: Zetas de La Pedriza!  '), 'ruta-mtb-zetas-de-la-pedriza');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
});

test('slugify: long names are cut at a word boundary', () => {
  const s = slugify('Techo de Asturias y Leon Torre Cerredo con Refugios de Vegarredonda y Vega de Ario por el Jou Santu', 40);
  assert.ok(s.length <= 40);
  assert.ok(!s.endsWith('-'));
  assert.ok('techo-de-asturias-y-leon-torre-cerredo-con'.startsWith(s));
});
