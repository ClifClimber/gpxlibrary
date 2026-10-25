'use strict';
// Applies repo/pg/NNN_*.sql in order, once each, recording them in schema_migrations.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'pg');

async function migrate(pool, log = () => {}) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
  const files = fs.readdirSync(DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const client = await pool.connect();
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
    } finally { client.release(); }
  }
  return applied;
}

module.exports = { migrate };
