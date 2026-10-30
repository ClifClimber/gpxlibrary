'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { esc, jsonForScript, trackPath, listPath, userPath, renderRobots } = require('./public-pages');

test('esc: user text cannot open tags or attributes', () => {
  assert.equal(esc('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
  assert.equal(esc("O'Donnell & Cía"), 'O&#39;Donnell &amp; Cía');
  assert.equal(esc(null), '');
});

test('jsonForScript: a name cannot close the <script> block and still parses to the same value', () => {
  const v = { name: '</script><script>alert(1)</script>', s: 'a\u2028b', amp: 'x&y' };
  const out = jsonForScript(v);
  assert.doesNotMatch(out, /<\/script/i);
  assert.doesNotMatch(out, /[\u2028\u2029]/);
  assert.deepEqual(JSON.parse(out), v);
  assert.equal(vm.runInNewContext('(' + out + ').name'), v.name);
});

test('public paths: id plus readable slug', () => {
  assert.equal(trackPath({ id: 501, name: 'Peñalara por la Laguna' }), '/ruta/501-penalara-por-la-laguna');
  assert.equal(trackPath({ id: 7, name: '***' }), '/ruta/7');
  assert.equal(listPath({ id: 3, name: 'Mis favoritas' }), '/lista/3-mis-favoritas');
  assert.equal(userPath('ana.b'), '/u/ana.b');
});

test('robots.txt points to the sitemap and keeps the API out', () => {
  const r = renderRobots({ base: 'https://rutas.example.com' });
  assert.match(r, /Sitemap: https:\/\/rutas\.example\.com\/sitemap\.xml/);
  assert.match(r, /Disallow: \/api\//);
  assert.match(r, /Allow: \/ruta\//);
});
