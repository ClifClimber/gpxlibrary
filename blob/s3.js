'use strict';
// Minimal S3 client on node:http(s) with AWS Signature V4 and path-style URLs (no dependencies).
// Works with Garage, Cloudflare R2 and AWS S3. Only what the store needs: put/get/head/delete/list.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const sha256hex = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function createS3Blob({ endpoint, region = 'us-east-1', bucket, accessKeyId, secretAccessKey, prefix = '' }) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error('Almacén S3 sin configurar: define S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY en .env');
  const base = new URL(endpoint);
  const lib = base.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 16 });

  function request(method, key, { body = Buffer.alloc(0), query = {} } = {}) {
    const segs = key == null ? [bucket] : [bucket, ...(prefix + key).split('/')];
    const uri = '/' + segs.map(enc).join('/');
    const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(String(query[k]))}`).join('&');
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body);
    const signed = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const names = Object.keys(signed);
    const canonical = [method, uri, qs, names.map(h => `${h}:${signed[h]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
    const kSign = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
    const headers = { ...signed, 'content-length': body.length,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
    return new Promise((resolve, reject) => {
      const req = lib.request({ protocol: base.protocol, hostname: base.hostname, port: base.port, method,
        path: uri + (qs ? '?' + qs : ''), headers, agent, timeout: 30000 }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('S3: tiempo de espera agotado')));
      req.on('error', e => reject(e.code === 'ECONNREFUSED' ? new Error(`S3 no responde en ${endpoint} (¿Docker parado?)`) : e));
      req.end(body);
    });
  }
  const fail = (r, what) => {
    const code = /<Code>([^<]+)<\/Code>/.exec(r.body.toString())?.[1];
    return new Error(`S3 ${what}: HTTP ${r.status}${code ? ' ' + code : ''}`);
  };

  const api = {
    driver: 's3',
    where: `${endpoint.replace(/\/$/, '')}/${bucket}${prefix ? '/' + prefix.replace(/\/$/, '') : ''}`,
    async put(key, buf) {
      if (await api.exists(key)) throw new Error(`Ya existe en el almacén: ${key}`);   // originals are never overwritten
      const r = await request('PUT', key, { body: buf });
      if (r.status !== 200) throw fail(r, `PUT ${key}`);
    },
    async get(key) {
      const r = await request('GET', key);
      if (r.status === 404) return null;
      if (r.status !== 200) throw fail(r, `GET ${key}`);
      return r.body;
    },
    async exists(key) {
      const r = await request('HEAD', key);
      if (r.status === 404) return false;
      if (r.status !== 200) throw fail(r, `HEAD ${key}`);
      return true;
    },
    async del(key) {
      const r = await request('DELETE', key);
      if (r.status !== 204 && r.status !== 200) throw fail(r, `DELETE ${key}`);
      return true;
    },
    async list() {
      const out = [];
      let token = null;
      do {
        const query = { 'list-type': '2', prefix };
        if (token) query['continuation-token'] = token;
        const r = await request('GET', null, { query });
        if (r.status !== 200) throw fail(r, 'LIST');
        const xml = r.body.toString();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = unxml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])[1]).slice(prefix.length);
          out.push({ key, size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0) });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] || '') : null;
      } while (token);
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async ping() {
      const r = await request('HEAD', null);
      if (r.status !== 200) throw fail(r, `bucket ${bucket}`);
      return true;
    },
    async close() { agent.destroy(); },
  };
  return api;
}

module.exports = { createS3Blob };
