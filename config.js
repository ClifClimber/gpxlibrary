'use strict';
// Runtime configuration from environment variables, with a minimal .env loader (no dependency).
// Variables already set in the environment win over .env.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const DB_DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
if (!['sqlite', 'postgres'].includes(DB_DRIVER)) throw new Error(`DB_DRIVER no válido: ${DB_DRIVER} (sqlite | postgres)`);

module.exports = {
  ROOT,
  DB_DRIVER,
  DATABASE_URL: process.env.DATABASE_URL || '',
  SQLITE_PATH: process.env.SQLITE_PATH || path.join(ROOT, 'data', 'tracks.db'),
};
