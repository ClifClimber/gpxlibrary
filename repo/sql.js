'use strict';
// Async SQL access for scripts and maintenance code. Always PostgreSQL.
// Write portable SQL with `?` placeholders; use `db.NOW` for timestamp columns,
// `db.NOW_TEXT` for 'YYYY-MM-DD HH:MM:SS' text columns, `db.BIN` after a text ORDER BY term
// for byte-order sorting, and getPoints / setPoints for GPS points (PostGIS geometry).
const config = require('../config');

function toPgPlaceholders(sql) {
  let n = 0, inStr = false, out = '';
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += ch === '?' && !inStr ? `$${++n}` : ch;
  }
  return out;
}

function openSql({ pool } = {}) {
  const { Pool } = require('pg');
  const { parseWkbLine, lineParams } = require('./postgres');
  const ownPool = !pool;
  pool = pool || new Pool({ connectionString: config.DATABASE_URL });
  const make = client => {
    const q = (sql, params) => client.query(toPgPlaceholders(sql), params);
    const api = {
      driver: 'postgres',
      NOW: 'now()',
      NOW_TEXT: "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
      BIN: 'COLLATE "C"',
      async all(sql, params = []) { return (await q(sql, params)).rows; },
      async get(sql, params = []) { return (await q(sql, params)).rows[0] ?? null; },
      async run(sql, params = []) {
        const r = await q(sql, params);
        return { changes: r.rowCount, lastId: r.rows?.[0]?.id ?? null };
      },
      async exec(sql) { await client.query(sql); },
      async tx(fn) {
        if (client !== pool) return fn(api);           // already inside a transaction
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn(make(c)); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      },
      async getPoints(id, { clean = false } = {}) {
        const r = (await client.query(`SELECT ST_AsBinary(${clean ? 'geom_clean' : 'geom'}) AS wkb, ${clean ? 'ele_clean' : 'ele'} AS ele FROM tracks WHERE id=$1`, [id])).rows[0];
        if (!r || !r.wkb) return [];
        return parseWkbLine(r.wkb).map((p, i) => ({ lat: p.lat, lon: p.lon, ele: r.ele ? r.ele[i] ?? null : null }));
      },
      async setPoints(id, points, { clean = false } = {}) {
        const [geom, ele] = lineParams(points);
        await client.query(`UPDATE tracks SET ${clean ? 'geom_clean' : 'geom'} = ST_GeomFromText($1, 4326), ${clean ? 'ele_clean' : 'ele'} = $2 WHERE id = $3`, [geom, ele, id]);
      },
      async close() { if (ownPool) await pool.end(); },
    };
    return api;
  };
  return make(pool);
}

module.exports = { openSql, toPgPlaceholders };
