'use strict';
// Pure parts of the visor search (query parsing and SQL building). The end-to-end comparison with the
// visor's own filtering runs against a live server: node scripts/search-check.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSearchParams, buildSearchSql, bind, COUNT_CAP } = require('./search');

const P = q => parseSearchParams(new URLSearchParams(q));
const viewer = { sub: 7, role: 'user' };

test('parseSearchParams: lists, numbers, text and limits', () => {
  const p = P('bbox=-4,40,-3,41&act=MTB&act=Gravel|Running&dmin=10&q=Peñalara&page=2&size=999&gmin=0&gmax=5&rtype=x');
  assert.deepEqual(p.bbox, [-4, 40, -3, 41]);
  assert.deepEqual(p.acts, ['MTB', 'Gravel', 'Running']);
  assert.equal(p.distMin, 10);
  assert.equal(p.q, 'penalara');
  assert.equal(p.page, 2);
  assert.equal(p.size, 60);
  assert.equal(p.gradeActive, false, 'the full 0–5 range is no filter');
  assert.deepEqual(p.rtype, []);
  assert.equal(P('bbox=1,2,3').bbox, null);
  assert.equal(P('').line, 's1');
  assert.equal(P('line=s2').line, 's2');
});

test('buildSearchSql: the box only goes in `where`, never in the pill counts', () => {
  const s = buildSearchSql(P('bbox=-4,40,-3,41&act=MTB'), viewer);
  assert.match(s.where, /t.box && ST_MakeEnvelope/);
  assert.doesNotMatch(s.base, /ST_MakeEnvelope/);
  assert.doesNotMatch(s.base, /activity/);
  assert.match(s.actC, /t\.activity = ANY/);
});

test('buildSearchSql: "Sin clasificar" matches routes without activity', () => {
  assert.match(buildSearchSql(P('act=Sin clasificar'), viewer).actC, /t\.activity IS NULL/);
  assert.doesNotMatch(buildSearchSql(P('act=MTB'), viewer).actC, /IS NULL/);
});

test('buildSearchSql: missing distance counts as 0, like the visor', () => {
  const lo = buildSearchSql(P('dmin=10&dmax=40'), viewer).base;
  assert.match(lo, /t\.distance >= \$\d+/);
  assert.match(lo, /\(t\.distance <= \$\d+ OR t\.distance IS NULL\)/);
  assert.doesNotMatch(lo, /t\.distance >= \$\d+ OR/);
});

test('buildSearchSql: LIKE wildcards in the text are escaped', () => {
  const s = buildSearchSql(P('q=50%_x'), viewer);
  assert.ok(s.args.includes(String.raw`%50\%\_x%`));
});

test('bind: renumbers and keeps only the parameters a query uses', () => {
  assert.deepEqual(bind('a = $3 AND b = $1 AND c = $3', ['x', 'y', 'z']), ['a = $2 AND b = $1 AND c = $2', ['x', 'z']]);
});

test('buildSearchSql: fuzzy mode uses trigram similarity for words of 3+ letters, exact LIKE otherwise', () => {
  const s = buildSearchSql({ ...P('q=pealara de'), fuzzy: true }, viewer);
  assert.match(s.base, /::text <<% t.search_text/);
  assert.match(s.base, /t.search_text LIKE/);
  assert.match(s.rank, /strict_word_similarity/);
  const exact = buildSearchSql(P('q=pealara'), viewer);
  assert.doesNotMatch(exact.base, /<%/);
  assert.equal(exact.rank, null);
});

test('buildSearchSql: the radius is evaluated once when its ids are given', () => {
  const p = P('near=40,-3,25');
  assert.match(buildSearchSql(p, viewer).base, /ST_DWithin/);
  const s = buildSearchSql(p, viewer, { nearIds: [1, 2] });
  assert.doesNotMatch(s.base, /ST_DWithin/);
  assert.match(s.nearSql, /ST_DWithin/);
});

test('COUNT_CAP is a sane limit', () => { assert.ok(COUNT_CAP >= 500); });
