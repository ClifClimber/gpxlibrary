'use strict';
// Contract tests: the same assertions run against every available store.
// Local uses a temporary folder; S3 uses the test bucket (S3_TEST_BUCKET, default "<S3_BUCKET>-test")
// and is skipped when it is not configured or not reachable.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const { createBlob } = require('./index');

const GPX = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<gpx><trk><name>Peñalara · ñ</name></trk></gpx>\n', 'utf8');
const BIN = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

function contract(name, make) {
  describe(name, () => {
    let blob, skip = false;
    before(async () => {
      try { blob = await make(); await blob.ping(); }
      catch (e) { skip = `${name} no disponible: ${e.message}`; return; }
      for (const { key } of await blob.list()) await blob.del(key);   // start from an empty store
    });
    after(async () => { if (blob && !skip) { for (const { key } of await blob.list()) await blob.del(key); await blob.close(); } });

    test('put / get / exists keep the exact bytes', async t => {
      if (skip) return t.skip(skip);
      await blob.put('a1b2-c3.gpx', GPX);
      await blob.put('bin.gpx', BIN);
      assert.deepEqual(await blob.get('a1b2-c3.gpx'), GPX);
      assert.deepEqual(await blob.get('bin.gpx'), BIN);
      assert.equal(await blob.exists('a1b2-c3.gpx'), true);
      assert.equal(await blob.exists('nope.gpx'), false);
      assert.equal(await blob.get('nope.gpx'), null);
    });

    test('never overwrites an original', async t => {
      if (skip) return t.skip(skip);
      await assert.rejects(blob.put('a1b2-c3.gpx', BIN), /Ya existe/);
      assert.deepEqual(await blob.get('a1b2-c3.gpx'), GPX);
    });

    test('list returns keys and sizes in byte order', async t => {
      if (skip) return t.skip(skip);
      await blob.put('B.gpx', GPX);
      assert.deepEqual(await blob.list(), [
        { key: 'B.gpx', size: GPX.length },
        { key: 'a1b2-c3.gpx', size: GPX.length },
        { key: 'bin.gpx', size: BIN.length },
      ]);
    });

    test('del removes the file; deleting a missing key is harmless', async t => {
      if (skip) return t.skip(skip);
      await blob.del('B.gpx');
      assert.equal(await blob.exists('B.gpx'), false);
      await blob.del('B.gpx');
      assert.equal((await blob.list()).length, 2);
    });
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpxblob-'));
contract('local', () => createBlob({ driver: 'local', dir: tmpDir }));
contract('s3', () => {
  const bucket = process.env.S3_TEST_BUCKET || (config.S3.bucket && `${config.S3.bucket}-test`);
  return createBlob({ driver: 's3', s3: { ...config.S3, bucket, prefix: '' } });
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
