'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { enableCompression, pickEncoding } = require('./compress');

const BIG = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: 'Ruta ' + i, km: i * 1.5 })));

function serve(handler) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => { enableCompression(req, res); handler(req, res); });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function get(srv, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: '/', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('pickEncoding prefers brotli, honours q=0', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
});

test('JSON sent with writeHead + end is compressed and decodes to the same body', async () => {
  const srv = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"x1"' }); res.end(BIG); });
  try {
    const br = await get(srv, { 'accept-encoding': 'gzip, br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.etag, '"x1"');
    assert.ok(br.body.length < BIG.length / 3);
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), BIG);
    const gz = await get(srv, { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.body).toString(), BIG);
    const plain = await get(srv);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), BIG);
  } finally { srv.close(); }
});

test('small bodies, errors, binaries and streams are left alone', async () => {
  for (const handler of [
    (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); },
    (req, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(BIG); },
    (req, res) => { res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(Buffer.from(BIG)); },
    (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: 1\n\n'); res.end(BIG); },
  ]) {
    const srv = await serve(handler);
    try {
      const r = await get(srv, { 'accept-encoding': 'br' });
      assert.equal(r.headers['content-encoding'], undefined);
    } finally { srv.close(); }
  }
});
