'use strict';
// Job queue backed by pg-boss (v12). pg-boss handles atomic claiming, expiry and pruning of its
// own tables; our `jobs` and `job_logs` tables remain the source of truth for the Admin UI and
// streaming output. Each job has an integer id (human-readable) linked to a pg-boss UUID.
const { PgBoss } = require('pg-boss');
const config = require('../config');

const TERMINAL = ['done', 'failed', 'cancelled'];
const STALE_SECONDS = 90;
const BACKOFF_SECONDS = 30;
const QUEUE_NAME = 'job';
const EXPIRE_SECONDS = 7200; // safety net; recoverStale(90) fires long before this

/** Creates a started pg-boss instance. Call once at server/worker startup. */
async function startBoss() {
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on('error', e => console.error('[pg-boss]', e.message));
  await boss.start();
  await boss.createQueue(QUEUE_NAME, { expireInSeconds: EXPIRE_SECONDS, retryLimit: 0 });
  return boss;
}

/** Returns the queue API. Both `db` (openSql) and `boss` (started PgBoss) are required. */
function createQueue(db, boss) {
  if (!boss) throw new Error('pg-boss instance required; pass the result of startBoss()');

  const shift = secs => `now() + make_interval(secs => ${Number(secs)})`;
  const iso = v => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 19) + 'Z' : String(v).replace(' ', 'T').slice(0, 19) + 'Z');
  const json = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const job = r => r && {
    id: Number(r.id), type: r.type, payload: json(r.payload) || {}, status: r.status,
    attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
    createdAt: iso(r.created_at), runAt: iso(r.run_at), startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at), heartbeatAt: iso(r.heartbeat_at),
    lockedBy: r.locked_by ?? null, error: r.error ?? null, result: json(r.result),
    pgbossId: r.pgboss_id ?? null,
    ...(r.last_line !== undefined && { lastLine: r.last_line ?? null }),
  };

  const api = {
    driver: db.driver,

    async enqueue(type, payload = {}, { maxAttempts = 1, delaySeconds = 0 } = {}) {
      const row = await db.get(
        `INSERT INTO jobs (type, payload, max_attempts, run_at) VALUES (?, ?, ?, ${shift(delaySeconds)}) RETURNING *`,
        [type, JSON.stringify(payload), maxAttempts]);
      const pgbossId = await boss.send(QUEUE_NAME, { job_id: row.id },
        delaySeconds > 0 ? { startAfter: delaySeconds } : undefined,
      ).catch(e => { console.warn('[queue] pg-boss send failed:', e.message); return null; });
      if (pgbossId) {
        await db.run(`UPDATE jobs SET pgboss_id = ? WHERE id = ?`, [pgbossId, row.id]);
        row.pgboss_id = pgbossId;
      }
      return job(row);
    },

    async claim(workerId) {
      const [fetched] = await boss.fetch(QUEUE_NAME);
      if (!fetched) return null;
      const jobId = fetched.data?.job_id;
      if (!jobId) {
        boss.fail(QUEUE_NAME, fetched.id, { error: 'missing job_id' }).catch(() => {});
        return null;
      }
      const row = await db.get(
        `UPDATE jobs SET status = 'running', locked_by = ?, attempts = attempts + 1,
                started_at = ${db.NOW}, heartbeat_at = ${db.NOW}, error = NULL
         WHERE id = ? AND status = 'queued'
         RETURNING *`,
        [workerId, jobId]);
      if (!row) {
        boss.fail(QUEUE_NAME, fetched.id, { error: 'job not in queued state' }).catch(() => {});
        return null;
      }
      row.pgboss_id = fetched.id;
      return job(row);
    },

    async heartbeat(id) {
      const r = await db.get(`UPDATE jobs SET heartbeat_at = ${db.NOW} WHERE id = ? RETURNING status, pgboss_id`, [id]);
      if (!r) return null;
      if (r.pgboss_id) boss.touch(QUEUE_NAME, r.pgboss_id).catch(() => {});
      return r.status;
    },

    async log(id, lines) {
      if (!lines.length) return;
      await db.run(`INSERT INTO job_logs (job_id, seq, level, text) VALUES ${lines.map(() => '(?, ?, ?, ?)').join(', ')}`,
        lines.flatMap(l => [id, l.seq, l.level, l.text]));
    },

    async complete(id, result = null) {
      const row = await db.get(
        `UPDATE jobs SET status = 'done', finished_at = ${db.NOW}, result = ? WHERE id = ? RETURNING pgboss_id`,
        [result == null ? null : JSON.stringify(result), id]);
      if (row?.pgboss_id) boss.complete(QUEUE_NAME, row.pgboss_id, result).catch(() => {});
    },

    async fail(j, error, result = null) {
      const retry = j.attempts < j.maxAttempts;
      const res = result == null ? null : JSON.stringify(result);
      if (j.pgbossId) boss.fail(QUEUE_NAME, j.pgbossId, { error }).catch(() => {});
      if (retry) {
        const delaySecs = BACKOFF_SECONDS * 2 ** (j.attempts - 1);
        const pgbossId = await boss.send(QUEUE_NAME, { job_id: j.id }, { startAfter: delaySecs })
          .catch(() => null);
        await db.run(
          `UPDATE jobs SET status = 'queued', locked_by = NULL, error = ?, result = ?,
           run_at = ${shift(delaySecs)}, pgboss_id = ? WHERE id = ?`,
          [error, res, pgbossId, j.id]);
      } else {
        await db.run(`UPDATE jobs SET status = 'failed', finished_at = ${db.NOW}, error = ?, result = ? WHERE id = ?`,
          [error, res, j.id]);
      }
      return retry;
    },

    async release(id) {
      const row = await db.get(
        `UPDATE jobs SET status = 'queued', locked_by = NULL, attempts = attempts - 1, run_at = ${db.NOW}
         WHERE id = ? AND status = 'running' RETURNING pgboss_id`,
        [id]);
      if (!row) return;
      if (row.pgboss_id) boss.fail(QUEUE_NAME, row.pgboss_id, { released: true }).catch(() => {});
      const pgbossId = await boss.send(QUEUE_NAME, { job_id: id }).catch(() => null);
      if (pgbossId) await db.run(`UPDATE jobs SET pgboss_id = ? WHERE id = ?`, [pgbossId, id]);
    },

    async markCancelled(id) {
      const row = await db.get(
        `UPDATE jobs SET status = 'cancelled', finished_at = ${db.NOW} WHERE id = ? RETURNING pgboss_id`,
        [id]);
      if (row?.pgboss_id) boss.cancel(QUEUE_NAME, row.pgboss_id).catch(() => {});
    },

    async cancel(id) {
      const r = await db.get(
        `UPDATE jobs SET status = CASE status WHEN 'queued' THEN 'cancelled' ELSE 'cancelling' END,
                finished_at = CASE status WHEN 'queued' THEN ${db.NOW} ELSE finished_at END
         WHERE id = ? AND status IN ('queued', 'running') RETURNING status, pgboss_id`,
        [id]);
      if (!r) return null;
      if (r.status === 'cancelled' && r.pgboss_id) boss.cancel(QUEUE_NAME, r.pgboss_id).catch(() => {});
      return r.status;
    },

    async retry(id) {
      const j = await api.get(id);
      if (!j || !TERMINAL.includes(j.status)) return null;
      return api.enqueue(j.type, j.payload, { maxAttempts: j.maxAttempts });
    },

    async get(id) {
      return job(await db.get('SELECT * FROM jobs WHERE id = ?', [id]));
    },

    async list({ limit = 50 } = {}) {
      return (await db.all(
        `SELECT j.*, (SELECT text FROM job_logs l WHERE l.job_id = j.id ORDER BY seq DESC LIMIT 1) AS last_line
         FROM jobs j ORDER BY j.id DESC LIMIT ?`, [limit])).map(job);
    },

    async logs(id, afterSeq = 0, limit = 2000) {
      return (await db.all('SELECT seq, level, text FROM job_logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', [id, afterSeq, limit]))
        .map(r => ({ seq: Number(r.seq), level: r.level, text: r.text }));
    },

    async activeCount() {
      return Number((await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM jobs WHERE status IN ('queued', 'running', 'cancelling')")).n);
    },

    async dataVersion() {
      const r = await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n, MAX(id) AS m FROM jobs WHERE status = 'done'");
      return `${r.n}:${r.m ?? 0}`;
    },

    async recoverStale(staleSeconds = STALE_SECONDS) {
      const lost = `heartbeat_at < ${shift(-staleSeconds)}`;
      const a = await db.run(`UPDATE jobs SET status = 'cancelled', finished_at = ${db.NOW} WHERE status = 'cancelling' AND ${lost}`);
      // Stale running jobs that have retries left: re-queue in our table and in pg-boss
      const staleRows = await db.all(
        `UPDATE jobs SET status = 'queued', locked_by = NULL, run_at = ${db.NOW},
         error = 'El proceso que lo ejecutaba se detuvo; se reintenta', pgboss_id = NULL
         WHERE status = 'running' AND attempts < max_attempts AND ${lost}
         RETURNING id`);
      for (const row of staleRows) {
        const pgbossId = await boss.send(QUEUE_NAME, { job_id: row.id }).catch(() => null);
        if (pgbossId) await db.run(`UPDATE jobs SET pgboss_id = ? WHERE id = ?`, [pgbossId, row.id]);
      }
      const c = await db.run(
        `UPDATE jobs SET status = 'failed', finished_at = ${db.NOW},
         error = 'El proceso que lo ejecutaba se detuvo'
         WHERE status = 'running' AND attempts >= max_attempts AND ${lost}`);
      return a.changes + staleRows.length + c.changes;
    },

    async prune(days = 30) {
      return (await db.run(`DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled') AND finished_at < ${shift(-days * 86400)}`)).changes;
    },
  };
  return api;
}

module.exports = { createQueue, startBoss, TERMINAL };
