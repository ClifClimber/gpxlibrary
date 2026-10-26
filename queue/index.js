'use strict';
// Job queue stored in the application database (tables `jobs` and `job_logs`), with the same API on
// SQLite and PostgreSQL through repo/sql.js. Workers claim jobs atomically — FOR UPDATE SKIP LOCKED in
// Postgres, a single UPDATE … RETURNING in SQLite — retry them with exponential backoff and recover
// the ones whose worker stopped sending heartbeats.
// Own implementation while SQLite is supported; when it is dropped, swap it for pg-boss behind this API.
const { openSql } = require('../repo/sql');

const TERMINAL = ['done', 'failed', 'cancelled'];
const STALE_SECONDS = 90;          // a running job without heartbeat for this long is considered lost
const BACKOFF_SECONDS = 30;        // first retry delay; doubles on each attempt

function createQueue(db = openSql()) {
  const pg = db.driver === 'postgres';
  const shift = secs => (pg ? `now() + make_interval(secs => ${Number(secs)})` : `datetime('now', '${secs >= 0 ? '+' : ''}${Number(secs)} seconds')`);
  const iso = v => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 19) + 'Z' : String(v).replace(' ', 'T').slice(0, 19) + 'Z');
  const json = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const job = r => r && {
    id: Number(r.id), type: r.type, payload: json(r.payload) || {}, status: r.status,
    attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
    createdAt: iso(r.created_at), runAt: iso(r.run_at), startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at), heartbeatAt: iso(r.heartbeat_at),
    lockedBy: r.locked_by ?? null, error: r.error ?? null, result: json(r.result),
    ...(r.last_line !== undefined && { lastLine: r.last_line ?? null }),
  };

  const api = {
    driver: db.driver,

    /** Adds a job; it runs as soon as a worker is free (or after delaySeconds). */
    async enqueue(type, payload = {}, { maxAttempts = 1, delaySeconds = 0 } = {}) {
      return job(await db.get(
        `INSERT INTO jobs (type, payload, max_attempts, run_at) VALUES (?, ?, ?, ${shift(delaySeconds)}) RETURNING *`,
        [type, JSON.stringify(payload), maxAttempts]));
    },

    /** Takes the next due job for this worker, or null. Never hands the same job to two workers. */
    async claim(workerId) {
      return job(await db.get(
        `UPDATE jobs SET status = 'running', locked_by = ?, attempts = attempts + 1,
                started_at = ${db.NOW}, heartbeat_at = ${db.NOW}, error = NULL
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ${db.NOW}
                     ORDER BY run_at, id LIMIT 1${pg ? ' FOR UPDATE SKIP LOCKED' : ''})
         RETURNING *`, [workerId]));
    },

    /** Keeps a running job alive; returns its status ('cancelling' tells the worker to stop it). */
    async heartbeat(id) {
      const r = await db.get(`UPDATE jobs SET heartbeat_at = ${db.NOW} WHERE id = ? RETURNING status`, [id]);
      return r ? r.status : null;
    },

    /** Appends output lines: [{ seq, level: 'log'|'warn'|'error', text }]. */
    async log(id, lines) {
      if (!lines.length) return;
      await db.run(`INSERT INTO job_logs (job_id, seq, level, text) VALUES ${lines.map(() => '(?, ?, ?, ?)').join(', ')}`,
        lines.flatMap(l => [id, l.seq, l.level, l.text]));
    },

    async complete(id, result = null) {
      await db.run(`UPDATE jobs SET status = 'done', finished_at = ${db.NOW}, result = ? WHERE id = ?`,
        [result == null ? null : JSON.stringify(result), id]);
    },

    /** Failure: back to the queue with backoff while attempts remain, otherwise 'failed'. */
    async fail(j, error, result = null) {
      const retry = j.attempts < j.maxAttempts;
      const res = result == null ? null : JSON.stringify(result);
      if (retry) await db.run(`UPDATE jobs SET status = 'queued', locked_by = NULL, error = ?, result = ?,
                               run_at = ${shift(BACKOFF_SECONDS * 2 ** (j.attempts - 1))} WHERE id = ?`, [error, res, j.id]);
      else await db.run(`UPDATE jobs SET status = 'failed', finished_at = ${db.NOW}, error = ?, result = ? WHERE id = ?`, [error, res, j.id]);
      return retry;
    },

    /** The worker stopped on purpose (shutdown): the job goes back to the queue without using an attempt. */
    async release(id) {
      await db.run(`UPDATE jobs SET status = 'queued', locked_by = NULL, attempts = attempts - 1, run_at = ${db.NOW}
                    WHERE id = ? AND status = 'running'`, [id]);
    },

    async markCancelled(id) {
      await db.run(`UPDATE jobs SET status = 'cancelled', finished_at = ${db.NOW} WHERE id = ?`, [id]);
    },

    /** Cancel requested by the user: queued → cancelled now; running → 'cancelling' until its worker stops it. */
    async cancel(id) {
      const r = await db.get(
        `UPDATE jobs SET status = CASE status WHEN 'queued' THEN 'cancelled' ELSE 'cancelling' END,
                finished_at = CASE status WHEN 'queued' THEN ${db.NOW} ELSE finished_at END
         WHERE id = ? AND status IN ('queued', 'running') RETURNING status`, [id]);
      return r ? r.status : null;
    },

    /** Runs a finished job again as a new job (the original keeps its history). */
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

    /** Output lines after `afterSeq`, in order. */
    async logs(id, afterSeq = 0, limit = 2000) {
      return (await db.all('SELECT seq, level, text FROM job_logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', [id, afterSeq, limit]))
        .map(r => ({ seq: Number(r.seq), level: r.level, text: r.text }));
    },

    /** Jobs waiting or running (the database engine/store cannot be switched meanwhile). */
    async activeCount() {
      return Number((await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM jobs WHERE status IN ('queued', 'running', 'cancelling')")).n);
    },

    /** Changes whenever a job finishes successfully: lets the server drop caches built from the data. */
    async dataVersion() {
      const r = await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n, MAX(id) AS m FROM jobs WHERE status = 'done'");
      return `${r.n}:${r.m ?? 0}`;
    },

    /** Jobs whose worker vanished: running → retried or failed; cancelling → cancelled. */
    async recoverStale(staleSeconds = STALE_SECONDS) {
      const lost = `heartbeat_at < ${shift(-staleSeconds)}`;
      const a = await db.run(`UPDATE jobs SET status = 'cancelled', finished_at = ${db.NOW} WHERE status = 'cancelling' AND ${lost}`);
      const b = await db.run(`UPDATE jobs SET status = 'queued', locked_by = NULL, run_at = ${db.NOW},
                              error = 'El proceso que lo ejecutaba se detuvo; se reintenta'
                              WHERE status = 'running' AND attempts < max_attempts AND ${lost}`);
      const c = await db.run(`UPDATE jobs SET status = 'failed', finished_at = ${db.NOW},
                              error = 'El proceso que lo ejecutaba se detuvo'
                              WHERE status = 'running' AND attempts >= max_attempts AND ${lost}`);
      return a.changes + b.changes + c.changes;
    },

    /** Removes finished jobs (and their logs) older than `days`. */
    async prune(days = 30) {
      return (await db.run(`DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled') AND finished_at < ${shift(-days * 86400)}`)).changes;
    },
  };
  return api;
}

module.exports = { createQueue, TERMINAL };
