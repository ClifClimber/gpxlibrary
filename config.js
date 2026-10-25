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

function withHost(url, host) {
  if (!url || !host) return url;
  const u = new URL(url);
  u.host = host;
  return u.toString();
}

const STORAGE_DRIVER =(process.env.STORAGE_DRIVER || 'local').toLowerCase();
if (!['local', 's3'].includes(STORAGE_DRIVER)) throw new Error(`STORAGE_DRIVER no válido: ${STORAGE_DRIVER} (local | s3)`);

module.exports = {
  ROOT,
  DB_DRIVER,
  // DATABASE_HOST (host:port) replaces the host of DATABASE_URL, e.g. `db:5432` inside docker-compose
  DATABASE_URL: withHost(process.env.DATABASE_URL || '', process.env.DATABASE_HOST),
  SQLITE_PATH: process.env.SQLITE_PATH || path.join(ROOT, 'data', 'tracks.db'),
  // Original GPX files: local folder or an S3-compatible bucket (Garage, R2, AWS)
  STORAGE_DRIVER,
  STORE_DIR: process.env.STORE_DIR || path.join(ROOT, 'TracksGps', 'store'),
  S3: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || 'garage',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    prefix: process.env.S3_PREFIX || '',
  },
};
