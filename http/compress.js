'use strict';
// Compresses text responses (JSON, HTML, CSS, JS, GPX…) with brotli or gzip when the browser accepts it.
// enableCompression(req, res) wraps writeHead/write/end of one response: the status line is held back
// until the body is known, so the encoding headers can still be added. Streamed responses (res.write,
// e.g. SSE) go out untouched. Bodies with an ETag are compressed once and kept in a small LRU cache.
const zlib = require('zlib');

const COMPRESSIBLE = /^(application\/(json|javascript|gpx\+xml|xml)|text\/(?!event-stream)|image\/svg\+xml)/;
const MIN_BYTES = 1024;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

const cache = new Map();   // key → Buffer (insertion order = LRU order)
let cacheBytes = 0;

function pickEncoding(acceptEncoding) {
  const h = String(acceptEncoding || '').toLowerCase();
  if (/(^|[\s,])br($|[\s,;])/.test(h) && !/br;\s*q=0(\.0*)?($|[\s,])/.test(h)) return 'br';
  if (/(^|[\s,])gzip($|[\s,;])/.test(h) && !/gzip;\s*q=0(\.0*)?($|[\s,])/.test(h)) return 'gzip';
  return null;
}

function compress(buf, enc) {
  return enc === 'br'
    ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : zlib.gzipSync(buf, { level: 6 });
}

function cached(key, make) {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const out = make();
  cache.set(key, out); cacheBytes += out.length;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k); cacheBytes -= v.length;
  }
  return out;
}

function enableCompression(req, res) {
  const enc = pickEncoding(req.headers['accept-encoding']);
  res.setHeader('Vary', 'Accept-Encoding');
  if (!enc || req.method === 'HEAD') return;

  const origWriteHead = res.writeHead.bind(res);
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let pending = null;   // { status, msg }

  res.writeHead = (status, a, b) => {
    const msg = typeof a === 'string' ? a : undefined;
    const headers = typeof a === 'string' ? b : a;
    if (headers && typeof headers === 'object' && !Array.isArray(headers))
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) res.setHeader(k, v);
    pending = { status, msg };
    return res;
  };
  const flush = () => {
    if (!pending) return;
    const p = pending; pending = null;
    if (p.msg) origWriteHead(p.status, p.msg); else origWriteHead(p.status);
  };
  res.write = (...args) => { flush(); return origWrite(...args); };
  res.end = (chunk, encoding, cb) => {
    if (typeof chunk === 'function') { flush(); return origEnd(chunk); }
    const status = pending ? pending.status : res.statusCode;
    const type = String(res.getHeader('content-type') || '');
    if (chunk != null && status === 200 && !res.headersSent && !res.getHeader('content-encoding') && COMPRESSIBLE.test(type)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      if (buf.length >= MIN_BYTES) {
        const etag = res.getHeader('etag');
        const out = etag ? cached(`${etag}|${enc}|${buf.length}`, () => compress(buf, enc)) : compress(buf, enc);
        res.setHeader('Content-Encoding', enc);
        res.setHeader('Content-Length', out.length);
        flush();
        return origEnd(out, typeof encoding === 'function' ? encoding : cb);
      }
    }
    flush();
    return origEnd(chunk, encoding, cb);
  };
}

module.exports = { enableCompression, pickEncoding };
