'use strict';
// PostgreSQL + PostGIS implementation of the repository. Returns rows shaped exactly like SQLite's.
const { Pool } = require('pg');
const C = require('./columns');

// Same ordering as SQLite (byte-wise), not the locale collation.
const BY_NAME = 'name COLLATE "C"';
// imported_at is stored as timestamptz but exposed like SQLite's datetime('now') text (UTC).
const IMPORTED_AT = `to_char(imported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS imported_at`;
const selectCols = cols => cols.map(c => (c === 'imported_at' ? IMPORTED_AT : c)).join(', ');

// WKB LineString (from ST_AsBinary) → [{lat, lon}]
function parseWkbLine(buf) {
  if (!buf) return [];
  const le = buf[0] === 1;
  const u32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = o => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  if ((u32(1) & 0xff) !== 2) throw new Error('WKB: se esperaba un LineString');
  const n = u32(5), out = new Array(n);
  for (let i = 0, o = 9; i < n; i++, o += 16) out[i] = { lat: f64(o + 8), lon: f64(o) };
  return out;
}

// Points → parameters for ST_GeomFromText + altitude array.
function lineParams(points) {
  if (!points || points.length < 2) return [null, null];
  return [`LINESTRING(${points.map(p => `${p.lon} ${p.lat}`).join(',')})`, points.map(p => (p.ele == null ? null : p.ele))];
}

function createPostgresRepo({ connectionString, pool: givenPool } = {}) {
  const pool = givenPool || new Pool({ connectionString });
  const q = (sql, params) => pool.query(sql, params);
  const rows = async (sql, params) => (await q(sql, params)).rows;
  const first = async (sql, params) => (await q(sql, params)).rows[0] || null;

  return {
    driver: 'postgres',
    pool,

    async listTracks() {
      return rows(`SELECT ${selectCols(C.LIST_COLS)},
        (SELECT username FROM users u WHERE u.id = tracks.owner_id) AS owner_username
        FROM tracks ORDER BY tracks.imported_at DESC, ${BY_NAME}, id`);
    },
    async getTrack(id) {
      return first(`SELECT ${selectCols(C.TRACK_COLS)} FROM tracks WHERE id=$1`, [id]);
    },
    async getPoints(id, { clean = false } = {}) {
      const r = await first(`SELECT ST_AsBinary(${clean ? 'geom_clean' : 'geom'}) AS wkb, ${clean ? 'ele_clean' : 'ele'} AS ele FROM tracks WHERE id=$1`, [id]);
      if (!r || !r.wkb) return [];
      return parseWkbLine(r.wkb).map((p, i) => ({ lat: p.lat, lon: p.lon, ele: r.ele ? r.ele[i] ?? null : null }));
    },
    async setTimes(id, moving, stopped) {
      await q('UPDATE tracks SET moving_time=$1, stopped_time=$2 WHERE id=$3', [moving, stopped, id]);
    },
    async updateTrack(id, fields) {
      const keys = C.editableFields(fields);
      if (!keys.length) return 0;
      const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(',');
      const extra = keys.includes('sierra') ? `, zone=COALESCE($${keys.indexOf('sierra') + 1}, zone)` : '';
      const r = await q(`UPDATE tracks SET ${sets}${extra} WHERE id=$${keys.length + 1}`, [...keys.map(k => fields[k] ?? null), id]);
      return r.rowCount;
    },
    async bulkUpdate(ids, fields, notesAppend = false) {
      const keys = C.editableFields(fields);
      if (!keys.length || !ids.length) return 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const plain = notesAppend ? keys.filter(k => k !== 'notes') : keys;
        if (plain.length) {
          await client.query(`UPDATE tracks SET ${plain.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id = ANY($${plain.length + 1}::int[])`,
            [...plain.map(k => fields[k] ?? null), ids]);
        }
        if (notesAppend && keys.includes('notes')) {
          await client.query(`UPDATE tracks SET notes = CASE WHEN notes IS NULL THEN $1 ELSE notes || E'\\n' || $1 END WHERE id = ANY($2::int[])`, [fields.notes, ids]);
        }
        if (keys.includes('sierra')) await client.query('UPDATE tracks SET zone=sierra WHERE id = ANY($1::int[]) AND sierra IS NOT NULL', [ids]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      return ids.length;
    },
    async moveTrack(id, activity, zone) {
      return (await q('UPDATE tracks SET activity=$1, zone=COALESCE($2, zone) WHERE id=$3', [activity, zone || null, id])).rowCount;
    },
    async deleteTrack(id) {
      const r = await first('DELETE FROM tracks WHERE id=$1 RETURNING file', [id]);
      return r ? r.file : null;
    },
    async tags() {
      const all = new Set();
      for (const r of await rows("SELECT tags FROM tracks WHERE tags IS NOT NULL AND tags != '[]'")) {
        try { JSON.parse(r.tags).forEach(t => all.add(t)); } catch {}
      }
      return [...all].sort();
    },
    async geo() {
      const distinct = async c => (await rows(`SELECT DISTINCT ${c} COLLATE "C" AS v FROM tracks WHERE ${c} IS NOT NULL AND ${c} != '' ORDER BY v`)).map(r => r.v);
      return { provinces: await distinct('province'), ccaa: await distinct('ccaa'), zones: await distinct('sierra') };
    },
    async recentIds() {
      return (await rows('SELECT id FROM tracks WHERE is_recent_import=1 ORDER BY id')).map(r => r.id);
    },
    async listConfig(table) {
      C.assertConfigTable(table);
      const order = C.CONFIG_TABLES[table].order.map(c => (c === 'name' ? BY_NAME : c)).join(', ');
      return rows(`SELECT * FROM ${table} ORDER BY ${order}, id`);
    },
    async createConfig(table, body) {
      C.assertConfigTable(table);
      const cols = C.CONFIG_TABLES[table].cols;
      return first(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, C.configValues(table, body, true));
    },
    async updateConfig(table, id, body) {
      C.assertConfigTable(table);
      const cols = C.CONFIG_TABLES[table].cols;
      return first(`UPDATE ${table} SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1} RETURNING *`,
        [...C.configValues(table, body, false), id]);
    },
    async deleteConfig(table, id) {
      C.assertConfigTable(table);
      await q(`DELETE FROM ${table} WHERE id=$1`, [id]);
    },
    async close() { if (!givenPool) await pool.end(); },
  };
}

module.exports = { createPostgresRepo, parseWkbLine, lineParams };
