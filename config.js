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

function withHost(url, host) {
  if (!url || !host) return url;
  const u = new URL(url);
  u.host = host;
  return u.toString();
}

module.exports = {
  ROOT,
  // DATABASE_HOST (host:port) replaces the host of DATABASE_URL, e.g. `db:5432` inside docker-compose
  DATABASE_URL: withHost(process.env.DATABASE_URL || '', process.env.DATABASE_HOST),
  // Original GPX files are always in S3 (Garage locally, R2/AWS in production)
  S3: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || 'garage',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    prefix: process.env.S3_PREFIX || '',
  },
  // Local mirror folder for GPX files (sync-local job). Relative paths resolve from ROOT.
  LOCAL_SYNC_DIR: process.env.LOCAL_SYNC_DIR || path.join(ROOT, 'TracksGps', 'local'),
  // Where track photos are stored (own Docker volume in production, data/photos locally).
  PHOTOS_DIR: process.env.PHOTOS_DIR || path.join(ROOT, 'data', 'photos'),
};
