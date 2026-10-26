'use strict';
// Contract tests for the S3 blob store (Garage locally, skipped if not reachable).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const { createBlob } = require('./index');

const GPX = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<gpx><trk><name>Peñalara · ñ</name></trk></gpx>\n', 'utf8');
const BIN = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

let blob, skip = false;
before(async () => {
  const bucket = process.env.S3_TEST_BUCKET || (config.S3.bucket && `${config.S3.bucket}-test`);
  if (!bucket) { skip = 'S3 no configurado'; return; }
  blob = createBlob({ s3: { ...config.S3, bucket, prefix: '' } });
  try { await blob.ping(); } catch (e) { skip = `S3 no disponible: ${e.message}`; }
  if (!skip) for (const { key } of await blob.list()) await blob.del(key);
});
after(async () => {
  if (blob && !skip) { for (const { key } of await blob.list()) await blob.del(key); await blob.close(); }
});

const it = (title, fn) => test(title, async t => { if (skip) return t.skip(skip); await fn(); });

it('put / get / exists keep the exact bytes', async () => {
  await blob.put('a1b2-c3.gpx', GPX);
  await blob.put('bin.gpx', BIN);
  assert.deepEqual(await blob.get('a1b2-c3.gpx'), GPX);
  assert.deepEqual(await blob.get('bin.gpx'), BIN);
  assert.equal(await blob.exists('a1b2-c3.gpx'), true);
  assert.equal(await blob.exists('nope.gpx'), false);
  assert.equal(await blob.get('nope.gpx'), null);
});

it('never overwrites an original', async () => {
  await assert.rejects(blob.put('a1b2-c3.gpx', BIN), /Ya existe/);
  assert.deepEqual(await blob.get('a1b2-c3.gpx'), GPX);
});

it('list returns keys and sizes in byte order', async () => {
  await blob.put('B.gpx', GPX);
  assert.deepEqual(await blob.list(), [
    { key: 'B.gpx', size: GPX.length },
    { key: 'a1b2-c3.gpx', size: GPX.length },
    { key: 'bin.gpx', size: BIN.length },
  ]);
});

it('del removes the file; deleting a missing key is harmless', async () => {
  await blob.del('B.gpx');
  assert.equal(await blob.exists('B.gpx'), false);
  await blob.del('B.gpx');
  assert.equal((await blob.list()).length, 2);
});
