'use strict';
// Applies repo/pg/NNN_*.sql in order, once each, recording them in schema_migrations.
// An advisory lock serialises concurrent starts (server and worker migrating at the same time).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'pg');
const LOCK_KEY = 715100;

async function migrate(pool, log = () => {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    const files = fs.readdirSync(DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(DIR, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`  ✓ migración ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migración ${f}: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

module.exports = { migrate };
