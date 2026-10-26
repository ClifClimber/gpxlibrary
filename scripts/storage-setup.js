'use strict';
// First-time setup of the local Garage store (safe to run again):
//   1. generates the Garage secrets and the S3 access key in .env if they are missing
//   2. starts the `storage` container
//   3. assigns the single-node layout, creates the buckets (app + tests) and grants the key access
// The app always uses S3; this script just configures the local Garage instance.
//   node scripts/storage-setup.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { dockerBin, dockerEnv } = require('./docker');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const CONTAINER = 'gpxlibrary-storage';
const hex = n => crypto.randomBytes(n).toString('hex');

function run(args, { check = true } = {}) {
  const r = spawnSync(dockerBin(), args, { cwd: ROOT, encoding: 'utf8', env: dockerEnv() });
  if (r.error) throw r.error;
  if (check && r.status !== 0) throw new Error(`docker ${args.join(' ')}\n${(r.stderr || r.stdout).trim()}`);
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
const garage = (args, opts) => run(['exec', CONTAINER, '/garage', ...args], opts);

// .env: keep existing values, append the missing ones
function ensureEnv() {
  let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const has = k => new RegExp(`^${k}=.+$`, 'm').test(text);
  const get = k => (new RegExp(`^${k}=(.*)$`, 'm').exec(text) || [])[1];
  const wanted = {
    GARAGE_RPC_SECRET: () => hex(32),
    GARAGE_ADMIN_TOKEN: () => hex(32),
    S3_ENDPOINT: () => 'http://127.0.0.1:3900',
    S3_REGION: () => 'garage',
    S3_BUCKET: () => 'gpxlibrary',
    S3_ACCESS_KEY_ID: () => 'GK' + hex(12),
    S3_SECRET_ACCESS_KEY: () => hex(32),
  };
  const added = Object.keys(wanted).filter(k => !has(k));
  if (added.length) {
    if (!/S3_ENDPOINT=/m.test(text)) text += `${text.endsWith('\n') || !text ? '' : '\n'}\n# Almacén de GPX en S3 (Garage en docker-compose, R2, AWS)\n`;
    for (const k of added) text += `${k}=${wanted[k]()}\n`;
    fs.writeFileSync(ENV, text);
    console.log(`✓ .env: añadidos ${added.join(', ')}`);
  } else console.log('✓ .env ya tenía la configuración del almacén');
  return Object.fromEntries(Object.keys(wanted).map(k => [k, get(k) ?? new RegExp(`^${k}=(.*)$`, 'm').exec(fs.readFileSync(ENV, 'utf8'))[1]]));
}

function waitReady() {
  for (let i = 0; i < 40; i++) {
    if (garage(['status'], { check: false }).ok) return;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
  }
  throw new Error('Garage no responde tras arrancar el contenedor');
}

function main() {
  const env = ensureEnv();
  console.log('… arrancando el contenedor storage');
  run(['compose', 'up', '-d', 'storage']);
  waitReady();

  const status = garage(['status']).out;
  if (/NO ROLE ASSIGNED/i.test(status)) {
    const nodeId = garage(['node', 'id', '-q']).out.trim().split('@')[0];
    garage(['layout', 'assign', '-z', 'local', '-c', '20G', nodeId]);
    const show = garage(['layout', 'show']).out;
    const current = Number((/Current cluster layout version:\s*(\d+)/i.exec(show) || [])[1] || 0);
    garage(['layout', 'apply', '--version', String(current + 1)]);
    console.log(`✓ Distribución del nodo aplicada (versión ${current + 1})`);
  } else console.log('✓ El nodo ya tenía distribución');

  if (!garage(['key', 'info', env.S3_ACCESS_KEY_ID], { check: false }).ok) {
    garage(['key', 'import', '--yes', '-n', 'gpxlibrary-app', env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY]);
    console.log('✓ Clave de acceso creada');
  } else console.log('✓ La clave de acceso ya existía');

  for (const bucket of [env.S3_BUCKET, `${env.S3_BUCKET}-test`]) {
    if (!garage(['bucket', 'info', bucket], { check: false }).ok) { garage(['bucket', 'create', bucket]); console.log(`✓ Bucket ${bucket} creado`); }
    else console.log(`✓ Bucket ${bucket} ya existía`);
    garage(['bucket', 'allow', '--read', '--write', '--owner', bucket, '--key', env.S3_ACCESS_KEY_ID]);
  }
  console.log(`\n✓ Almacén listo en ${env.S3_ENDPOINT} (bucket ${env.S3_BUCKET}).`);
  console.log('  Para copiar GPX existentes: node scripts/blob-copy.js --to s3   (si migrando desde almacén local)');
}

try { main(); } catch (e) { console.error('✗ ' + e.message); process.exit(1); }
