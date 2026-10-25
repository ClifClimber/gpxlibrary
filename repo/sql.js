'use strict';
// Engine-neutral async SQL access for scripts and maintenance code.
// Write portable SQL with `?` placeholders; use `db.NOW` for timestamp columns, `db.NOW_TEXT` for
// text columns that hold SQLite-style 'YYYY-MM-DD HH:MM:SS' dates, `db.BIN` after a text ORDER BY
// term for the same byte order on both engines, and
// getPoints / setPoints for GPS points (rows in SQLite, a PostGIS geometry in Postgres).
const config = require('../config');

function toPgPlaceholders(sql) {
  let n = 0, inStr = false, out = '';
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += ch === '?' && !inStr ? `$${++n}` : ch;
  }
  return out;
}

function sqliteSql() {
  const { openDb, closeDb } = require('../scripts/db');
  const raw = () => openDb();
  const api = {
    driver: 'sqlite',
    NOW: "datetime('now')",
    NOW_TEXT: "datetime('now')",
    BIN: '',
    async all(sql, params = []) { return raw().prepare(sql).all(...params); },
    async get(sql, params = []) { return raw().prepare(sql).get(...params) ?? null; },
    async run(sql, params = []) { const r = raw().prepare(sql).run(...params); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
    async exec(sql) { raw().exec(sql); },
    async tx(fn) {
      raw().exec('BEGIN');
      try { const r = await fn(api); raw().exec('COMMIT'); return r; }
      catch (e) { try { raw().exec('ROLLBACK'); } catch {} throw e; }
    },
    async getPoints(id, { clean = false } = {}) {
      return raw().prepare(`SELECT lat, lon, ele FROM ${clean ? 'clean_points' : 'raw_points'} WHERE track_id=? ORDER BY seq`).all(id)
        .map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
    },
    async setPoints(id, points, { clean = false } = {}) {
      const table = clean ? 'clean_points' : 'raw_points';
      raw().prepare(`DELETE FROM ${table} WHERE track_id=?`).run(id);
      const ins = raw().prepare(`INSERT INTO ${table}(track_id,seq,lat,lon,ele) VALUES(?,?,?,?,?)`);
      (points || []).forEach((p, i) => ins.run(id, i, p.lat, p.lon, p.ele ?? null));
    },
    async close() { closeDb(); },
  };
  return api;
}

function postgresSql(pool) {
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

/** Opens the engine selected by DB_DRIVER (or the one given). */
function openSql({ driver = config.DB_DRIVER, pool } = {}) {
  return driver === 'postgres' ? postgresSql(pool) : sqliteSql();
}

module.exports = { openSql, toPgPlaceholders };
