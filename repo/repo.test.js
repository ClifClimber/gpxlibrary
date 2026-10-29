'use strict';
// Contract tests for the PostgreSQL repository.
// Uses a separate database (gpxlibrary_test) and is skipped when DATABASE_URL is not reachable.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const { createPostgresRepo, lineParams } = require('./postgres');
const { migrate } = require('./pg-migrate');

const PTS_A = [{ lat: 40.123456789012, lon: -3.987654321098, ele: 1000.5 }, { lat: 40.2, lon: -3.9, ele: null }, { lat: 40.3, lon: -3.8, ele: 1200 }];
const PTS_B = [{ lat: 41, lon: -4 }, { lat: 41.1, lon: -4.1 }].map(p => ({ ...p, ele: 900 }));
const SEED = [
  { id: 1, name: 'Bravo', file: 'TracksGps/store/a.gpx', date: '2024-01-02', activity: 'MTB', sierra: 'Pedriza', province: 'Madrid', ccaa: 'Comunidad de Madrid', tags: '["peña","agua"]', imported_at: '2024-05-01 10:00:00', sw_lat: 40.1, sw_lon: -3.99, ne_lat: 40.3, ne_lon: -3.8, pts: PTS_A },
  { id: 2, name: 'alfa', file: 'TracksGps/store/b.gpx', date: null, activity: 'Senderismo', sierra: 'Álamo', province: 'Ávila', ccaa: 'Castilla y León', tags: '[]', imported_at: '2024-05-02 10:00:00', sw_lat: 41, sw_lon: -4.1, ne_lat: 41.1, ne_lon: -4, pts: PTS_B },
  { id: 3, name: 'Álamo', file: 'TracksGps/store/c.gpx', date: '2024-01-02', activity: 'MTB', sierra: null, province: null, ccaa: null, tags: '["agua"]', imported_at: '2024-05-02 10:00:00', sw_lat: 41, sw_lon: -4.1, ne_lat: 41.1, ne_lon: -4, pts: PTS_B },
];
const COLS = ['id', 'name', 'file', 'date', 'activity', 'sierra', 'province', 'ccaa', 'tags', 'imported_at', 'sw_lat', 'sw_lon', 'ne_lat', 'ne_lon', 'raw_count'];

async function postgresFixture() {
  if (!config.DATABASE_URL) return null;
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch { await admin.end().catch(() => {}); return null; }
  const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname='gpxlibrary_test'")).rowCount;
  if (!exists) await admin.query('CREATE DATABASE gpxlibrary_test');
  await admin.end();
  const url = new URL(config.DATABASE_URL); url.pathname = '/gpxlibrary_test';
  const pool = new Pool({ connectionString: url.toString() });
  await pool.query('DROP TABLE IF EXISTS track_search, user_list_tracks, user_lists, tracks, users, config_activities, config_sierras, job_logs, jobs, schema_migrations CASCADE');
  await migrate(pool);
  for (const t of SEED) {
    const [geom, ele] = lineParams(t.pts);
    const vals = COLS.map(c => (c === 'raw_count' ? t.pts.length : c === 'imported_at' ? t[c].replace(' ', 'T') + 'Z' : t[c]));
    await pool.query(`INSERT INTO tracks (${COLS.join(',')}, geom, ele) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')}, ST_GeomFromText($${COLS.length + 1}, 4326), $${COLS.length + 2})`, [...vals, geom, ele]);
  }
  return createPostgresRepo({ pool });
}

describe('postgres', () => {
  let repo;
  before(async () => { repo = await postgresFixture(); });
  after(async () => { if (repo) { await repo.close(); if (repo.pool) await repo.pool.end(); } });
  const it = (title, fn) => test(title, async t => { if (!repo) return t.skip('postgres no disponible'); await fn(); });

  it('listTracks: newest import first, then byte-wise name, then id', async () => {
    const rows = await repo.listTracks();
    assert.deepEqual(rows.map(r => r.id), [2, 3, 1]);   // byte order: 'alfa' (0x61) before 'Álamo' (0xC3)
    assert.equal(rows[0].imported_at, '2024-05-02 10:00:00');
  });

  it('getTrack and getPoints round-trip coordinates and missing elevation exactly', async () => {
    const t = await repo.getTrack(1);
    assert.equal(t.name, 'Bravo');
    assert.equal(t.tags, '["peña","agua"]');
    assert.deepEqual(await repo.getPoints(1), PTS_A);
    assert.deepEqual(await repo.getPoints(1, { clean: true }), []);
    assert.equal(await repo.getTrack(999), null);
  });

  it('updateTrack changes only editable fields and keeps zone in sync with sierra', async () => {
    assert.equal(await repo.updateTrack(3, { name: 'Nuevo', sierra: 'Gredos', file: 'x', bogus: 1 }), 1);
    const t = await repo.getTrack(3);
    assert.equal(t.name, 'Nuevo');
    assert.equal(t.sierra, 'Gredos');
    assert.equal(t.zone, 'Gredos');
    assert.equal(t.file, 'TracksGps/store/c.gpx');
    assert.equal(await repo.updateTrack(3, { bogus: 1 }), 0);
  });

  it('bulkUpdate with notes appended', async () => {
    await repo.bulkUpdate([1, 2], { activity: 'Gravel', notes: 'uno' }, true);
    await repo.bulkUpdate([1], { notes: 'dos' }, true);
    assert.equal((await repo.getTrack(1)).notes, 'uno\ndos');
    assert.equal((await repo.getTrack(2)).activity, 'Gravel');
  });

  it('moveTrack, tags, geo and recentIds', async () => {
    assert.equal(await repo.moveTrack(2, 'Trail Running', null), 1);
    assert.equal((await repo.getTrack(2)).activity, 'Trail Running');
    assert.equal(await repo.moveTrack(999, 'X', null), 0);
    assert.deepEqual(await repo.tags(), ['agua', 'peña']);
    assert.deepEqual(await repo.geo(), { provinces: ['Madrid', 'Ávila'], ccaa: ['Castilla y León', 'Comunidad de Madrid'], zones: ['Gredos', 'Pedriza', 'Álamo'] });
    assert.deepEqual(await repo.recentIds(), []);
    await repo.setTimes(1, 3600, 60);
    const t = await repo.getTrack(1);
    assert.deepEqual([t.moving_time, t.stopped_time], [3600, 60]);
  });

  it('config CRUD with the same defaults', async () => {
    const a = await repo.createConfig('config_activities', { name: 'Kayak' });
    assert.deepEqual({ ...a, id: undefined }, { id: undefined, name: 'Kayak', color: null, keywords: '', sort_order: 99, active: 1, icon: 'pin', image: null, icon_img: null });
    const u = await repo.updateConfig('config_activities', a.id, { name: 'Kayak', color: '#123456', active: 0 });
    assert.deepEqual([u.color, u.sort_order, u.active], ['#123456', 0, 0]);
    await repo.createConfig('config_sierras', { name: 'Gredos', sw_lat: 40, sw_lon: -5.5, ne_lat: 40.4, ne_lon: -4.9 });
    assert.deepEqual((await repo.listConfig('config_sierras')).map(r => r.name), ['Gredos']);
    await repo.deleteConfig('config_activities', a.id);
    assert.deepEqual(await repo.listConfig('config_activities'), []);
    await assert.rejects(repo.listConfig('tracks'));
  });

  it('deleteTrack returns the stored file and removes the row', async () => {
    assert.equal(await repo.deleteTrack(3), 'TracksGps/store/c.gpx');
    assert.equal(await repo.getTrack(3), null);
    assert.equal(await repo.deleteTrack(3), null);
  });

  // ── track_search (migration 020): narrow table kept by triggers, and the typo-tolerant text search ──
  const LINE = 'LINESTRING(-3.95 40.84, -3.96 40.85, -3.97 40.86)';
  const ins = (id, name, extra = {}) => repo.pool.query(
    `INSERT INTO tracks (id, name, file, activity, sierra, tags, sw_lat, sw_lon, ne_lat, ne_lon, raw_count, distance, elevation_gain,
        visibility, search_text, ibp_hiking, ibp_bicycle, geom, geom_s1, geom_view)
     VALUES ($1::int, $2, 'TracksGps/store/ts' || $1::text || '.gpx', $3, 'Guadarrama', $4, 40.84, -3.97, 40.86, -3.95, 3, $5, 300, $6, $7, $8, 20,
        ST_GeomFromText($9, 4326), ST_GeomFromText($9, 4326), ST_GeomFromText($9, 4326))`,
    [id, name, extra.activity ?? 'Senderismo', extra.tags ?? '["cumbre"]', extra.distance ?? 12, extra.visibility ?? 'public',
     name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() + ' guadarrama senderismo', extra.ibp ?? 120, LINE]);
  const ts = async id => (await repo.pool.query('SELECT * FROM track_search WHERE id = $1', [id])).rows[0];
  const search = (q, viewer = { sub: 999, role: 'user' }) =>
    require('./search').runSearch(require('./sql').openSql({ pool: repo.pool }), require('./search').parseSearchParams(new URLSearchParams(q)), viewer);

  it('track_search follows INSERT, UPDATE and DELETE of tracks by itself', async () => {
    await ins(100, 'Cumbre de Peñalara');
    let r = await ts(100);
    assert.deepEqual([r.name, r.visibility, r.hidden, r.tags, r.grade, r.ibp_sort, r.circular], ['Cumbre de Peñalara', 'public', false, ['cumbre'], 2, 120, false]);
    await repo.pool.query("UPDATE tracks SET visibility = 'private', tags = '[\"a\",\"b\"]', difficulty = 4, geom_view = NULL, circular = 1 WHERE id = 100");
    r = await ts(100);
    assert.deepEqual([r.visibility, r.hidden, r.tags, r.grade, r.circular], ['private', true, ['a', 'b'], 4, true]);
    await repo.pool.query("UPDATE tracks SET geom_s1 = NULL WHERE id = 100");
    assert.equal(await ts(100), undefined, 'a route without geom_s1 is not searchable');
    await repo.pool.query("UPDATE tracks SET geom_s1 = geom WHERE id = 100");
    await repo.pool.query("UPDATE tracks SET tags = 'not json' WHERE id = 100");
    assert.deepEqual((await ts(100)).tags, []);
    await repo.pool.query('DELETE FROM tracks WHERE id = 100');
    assert.equal(await ts(100), undefined);
  });

  it('search by text finds exact words; a typo only matches by similarity and is marked fuzzy', async () => {
    await ins(101, 'Cumbre de Peñalara');
    await ins(102, 'Ruta del Valle');
    const exact = await search('q=penalara');
    assert.deepEqual(exact.items.map(i => i.id), [101]);
    assert.ok(!exact.fuzzy, 'an exact search is not fuzzy');
    const typo = await search('q=pealara');
    assert.equal(typo.fuzzy, true);
    assert.deepEqual(typo.items.map(i => i.id), [101]);
    assert.equal(typo.total, 1);
    const none = await search('q=zzzqqq');
    assert.equal(none.total, 0);
    assert.ok(!none.fuzzy);
    // Matches exist but outside the box: the text is right, so no fuzzy fallback
    const away = await search('q=penalara&bbox=10,10,11,11');
    assert.equal(away.total, 0);
    assert.ok(!away.fuzzy);
    // Private routes of others never come out, fuzzy or not
    await repo.pool.query("UPDATE tracks SET visibility = 'private' WHERE id = 101");
    assert.equal((await search('q=pealara')).total, 0);
  });

  it('search: near, pill counts and ordering come from track_search', async () => {
    await repo.pool.query("UPDATE tracks SET visibility = 'public' WHERE id = 101");
    const r = await search('near=40.85,-3.96,5');
    assert.deepEqual(r.items.map(i => i.id).sort(), [101, 102]);
    assert.deepEqual(r.facets.activity, { Senderismo: 2 });
    assert.deepEqual(r.facets.tags, { cumbre: 2 });
    assert.equal((await search('near=38,-3.96,5')).total, 0);
    assert.deepEqual((await search('sort=id-desc')).items.map(i => i.id), [102, 101]);
  });

  it('migration 020 lists of cycling/running activities match repo/search.js', () => {
    const sql = require('fs').readFileSync(require('path').join(__dirname, 'pg', '020_track_search.sql'), 'utf8');
    const { CYCLING, RUNNING } = require('./search');
    for (const list of [CYCLING, RUNNING]) assert.ok(sql.includes(`ARRAY[${list.map(a => `'${a}'`).join(',')}]`), list.join());
  });
});
