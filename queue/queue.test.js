'use strict';
// Contract tests for the job queue and the worker. Uses a separate PostgreSQL database
// (gpxlibrary_test_queue) and is skipped when DATABASE_URL is not reachable.
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpxqueue-'));

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const { openSql } = require('../repo/sql');
const { migrate } = require('../repo/pg-migrate');
const { createQueue, startBoss } = require('./index');
const { createWorker } = require('./worker');

// Tiny scripts the worker runs in place of the real ones
const SCRIPTS = {
  ok: "console.log('uno'); console.log('⚠ aviso'); console.error('al stderr'); console.log('IMPORTED_IDS:7,8');",
  fail: "console.log('✗ algo falló'); process.exit(3);",
  slow: 'setInterval(() => console.log("…"), 100);',
};
for (const [k, src] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(tmpDir, `${k}.js`), src);
const resolveScript = type => (SCRIPTS[type] ? path.join(tmpDir, `${type}.js`) : null);

async function postgresFixture() {
  if (!config.DATABASE_URL) return null;
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch { await admin.end().catch(() => {}); return null; }
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='gpxlibrary_test_queue'")).rowCount) await admin.query('CREATE DATABASE gpxlibrary_test_queue');
  await admin.end();
  const url = new URL(config.DATABASE_URL); url.pathname = '/gpxlibrary_test_queue';
  const pool = new Pool({ connectionString: url.toString() });
  await migrate(pool);
  await pool.query('TRUNCATE jobs, job_logs RESTART IDENTITY');
  // Override DATABASE_URL so startBoss connects to the test database
  const origUrl = config.DATABASE_URL;
  config.DATABASE_URL = url.toString();
  const boss = await startBoss();
  config.DATABASE_URL = origUrl;
  // Flush any pending pg-boss jobs from previous runs
  await pool.query("DELETE FROM pgboss.job").catch(() => {});
  return { db: openSql({ pool }), boss, close: async () => { await boss.stop(); await pool.end(); } };
}

const until = async (fn, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) { const v = await fn(); if (v) return v; }
  throw new Error('timeout');
};

describe('postgres', () => {
  let db, boss, q, close;
  before(async () => { const f = await postgresFixture(); if (f) ({ db, boss, close } = f), q = createQueue(db, boss); });
  after(async () => { if (close) await close(); });
  const it = (title, fn) => test(title, async t => {
    if (!db) return t.skip('postgres no disponible');
    await db.exec('DELETE FROM jobs');
    await db.exec("DELETE FROM pgboss.job WHERE name = 'job'");
    await fn();
  });

  it('enqueue → claim → complete keeps the payload and records times', async () => {
    const j = await q.enqueue('ok', { args: ['--ids', '1,2'], n: 'ñ' });
    assert.equal(j.status, 'queued');
    assert.deepEqual(j.payload, { args: ['--ids', '1,2'], n: 'ñ' });
    assert.match(j.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const c = await q.claim('w1');
    assert.deepEqual([c.id, c.status, c.attempts, c.lockedBy], [j.id, 'running', 1, 'w1']);
    assert.equal(await q.claim('w2'), null);
    await q.complete(c.id, { ok: 1 });
    const d = await q.get(c.id);
    assert.deepEqual([d.status, d.result], ['done', { ok: 1 }]);
    assert.ok(d.finishedAt);
  });

  it('concurrent claims never hand out the same job', async () => {
    for (let i = 0; i < 3; i++) await q.enqueue('ok');
    const got = await Promise.all(Array.from({ length: 6 }, (_, i) => q.claim('w' + i)));
    const ids = got.filter(Boolean).map(j => j.id);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
  });

  it('a failure is retried later while attempts remain, then fails', async () => {
    const j = await q.enqueue('fail', {}, { maxAttempts: 2 });
    let c = await q.claim('w');
    assert.equal(await q.fail(c, 'boom'), true);
    assert.equal((await q.get(j.id)).status, 'queued');
    assert.equal(await q.claim('w'), null, 'not due yet (backoff)');
    await db.run('UPDATE jobs SET run_at = created_at WHERE id = ?', [j.id]);
    await db.run(`UPDATE pgboss.job SET start_after = now() WHERE id = (SELECT pgboss_id FROM jobs WHERE id = ?)`, [j.id]);
    c = await q.claim('w');
    assert.equal(c.attempts, 2);
    assert.equal(await q.fail(c, 'boom again'), false);
    const f = await q.get(j.id);
    assert.deepEqual([f.status, f.error], ['failed', 'boom again']);
  });

  it('cancel: queued at once, running through the worker; retry and release', async () => {
    const a = await q.enqueue('ok');
    assert.equal(await q.cancel(a.id), 'cancelled');
    assert.equal(await q.cancel(a.id), null);
    const b = await q.enqueue('ok');
    await q.claim('w');
    assert.equal(await q.cancel(b.id), 'cancelling');
    assert.equal(await q.heartbeat(b.id), 'cancelling');
    await q.markCancelled(b.id);
    const r = await q.retry(b.id);
    assert.deepEqual([r.type, r.status, r.id > b.id], ['ok', 'queued', true]);
    const c = await q.claim('w');
    await q.release(c.id);
    const back = await q.get(c.id);
    assert.deepEqual([back.status, back.attempts], ['queued', 0]);
    assert.equal(await q.activeCount(), 1);
  });

  it('logs, list with the last line, stale recovery, data version and pruning', async () => {
    const j = await q.enqueue('ok', {}, { maxAttempts: 2 });
    await q.claim('w');
    await q.log(j.id, [{ seq: 1, level: 'log', text: 'uno' }, { seq: 2, level: 'error', text: '✗ dos' }]);
    assert.deepEqual(await q.logs(j.id, 1), [{ seq: 2, level: 'error', text: '✗ dos' }]);
    assert.equal((await q.list())[0].lastLine, '✗ dos');

    await db.run(`UPDATE jobs SET heartbeat_at = now() - interval '1 hour' WHERE id = ?`, [j.id]);
    assert.equal(await q.recoverStale(), 1);
    assert.equal((await q.get(j.id)).status, 'queued');

    const v0 = await q.dataVersion();
    const c = await q.claim('w');
    await q.complete(c.id);
    assert.notEqual(await q.dataVersion(), v0);
    await db.run(`UPDATE jobs SET finished_at = now() - interval '40 days' WHERE id = ?`, [j.id]);
    assert.equal(await q.prune(30), 1);
    assert.equal(await q.get(j.id), null);
    assert.deepEqual(await q.logs(j.id), []);
  });

  it('worker runs a job, stores its output and the summary', async () => {
    const done = [];
    const w = createWorker({ getQueue: () => q, resolveScript, pollMs: 50, heartbeatMs: 100, log: { log() {}, error() {} },
      onFinish: (job, code) => done.push([job.id, code]) });
    w.start();
    try {
      const ok = await q.enqueue('ok');
      const bad = await q.enqueue('fail');
      await until(async () => done.length === 2);
      const a = await q.get(ok.id), b = await q.get(bad.id);
      assert.deepEqual([a.status, a.result.ids], ['done', [7, 8]]);
      const lines = (await q.logs(ok.id)).map(l => `${l.level}:${l.text}`).sort();   // stdout/stderr order is not fixed
      assert.deepEqual(lines, ['error:al stderr', 'log:IMPORTED_IDS:7,8', 'log:uno', 'warn:⚠ aviso']);
      assert.deepEqual([b.status, b.error], ['failed', 'Terminó con código 3']);

      const slow = await q.enqueue('slow');
      await until(async () => (await q.get(slow.id)).status === 'running');
      await q.cancel(slow.id);
      await until(async () => (await q.get(slow.id)).status === 'cancelled');
      assert.ok((await q.logs(slow.id)).some(l => l.text === '✗ Cancelado por el usuario'));
    } finally { await w.stop(); }
  });
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
