'use strict';
// SQLite implementation of the repository (node:sqlite, synchronous, wrapped in promises).
const { openDb, closeDb, withTransaction } = require('../scripts/db');
const C = require('./columns');

function createSqliteRepo() {
  const db = () => openDb();
  const one = (sql, ...a) => db().prepare(sql).get(...a);
  const all = (sql, ...a) => db().prepare(sql).all(...a);
  const run = (sql, ...a) => db().prepare(sql).run(...a);

  return {
    driver: 'sqlite',

    async listTracks() {
      return all(`SELECT ${C.LIST_COLS.join(', ')} FROM tracks ORDER BY imported_at DESC, name, id`);
    },
    async getTrack(id) {
      return one(`SELECT ${C.TRACK_COLS.join(', ')} FROM tracks WHERE id=?`, id) || null;
    },
    async getPoints(id, { clean = false } = {}) {
      return all(`SELECT lat, lon, ele FROM ${clean ? 'clean_points' : 'raw_points'} WHERE track_id=? ORDER BY seq`, id)
        .map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
    },
    async catalogTracks() {
      return all(`SELECT ${C.CATALOG_COLS.join(',')} FROM tracks ORDER BY date DESC, name ASC, id`);
    },
    async setTimes(id, moving, stopped) {
      run('UPDATE tracks SET moving_time=?, stopped_time=? WHERE id=?', moving, stopped, id);
    },
    async updateTrack(id, fields) {
      const keys = C.editableFields(fields);
      if (!keys.length) return 0;
      const r = run(`UPDATE tracks SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, ...keys.map(k => fields[k] ?? null), id);
      if (keys.includes('sierra')) run('UPDATE tracks SET zone=sierra WHERE id=? AND sierra IS NOT NULL', id);
      return Number(r.changes);
    },
    async bulkUpdate(ids, fields, notesAppend = false) {
      const keys = C.editableFields(fields);
      if (!keys.length || !ids.length) return 0;
      withTransaction(() => {
        const plain = notesAppend ? keys.filter(k => k !== 'notes') : keys;
        if (plain.length) {
          const st = db().prepare(`UPDATE tracks SET ${plain.map(k => `${k}=?`).join(',')} WHERE id=?`);
          for (const id of ids) st.run(...plain.map(k => fields[k] ?? null), id);
        }
        if (notesAppend && keys.includes('notes')) {
          const st = db().prepare('UPDATE tracks SET notes = CASE WHEN notes IS NULL THEN ? ELSE notes || char(10) || ? END WHERE id=?');
          for (const id of ids) st.run(fields.notes, fields.notes, id);
        }
        if (keys.includes('sierra')) {
          const st = db().prepare('UPDATE tracks SET zone=sierra WHERE id=? AND sierra IS NOT NULL');
          for (const id of ids) st.run(id);
        }
      });
      return ids.length;
    },
    async moveTrack(id, activity, zone) {
      return Number(run('UPDATE tracks SET activity=?, zone=COALESCE(?, zone) WHERE id=?', activity, zone || null, id).changes);
    },
    async deleteTrack(id) {
      const t = one('SELECT file FROM tracks WHERE id=?', id);
      if (!t) return null;
      run('DELETE FROM tracks WHERE id=?', id);
      return t.file;
    },
    async tags() {
      const all_ = new Set();
      for (const r of all("SELECT tags FROM tracks WHERE tags IS NOT NULL AND tags != '[]'")) {
        try { JSON.parse(r.tags).forEach(t => all_.add(t)); } catch {}
      }
      return [...all_].sort();
    },
    async geo() {
      const distinct = c => all(`SELECT DISTINCT ${c} AS v FROM tracks WHERE ${c} IS NOT NULL AND ${c} != '' ORDER BY ${c}`).map(r => r.v);
      return { provinces: distinct('province'), ccaa: distinct('ccaa'), zones: distinct('sierra') };
    },
    async recentIds() {
      return all('SELECT id FROM tracks WHERE is_recent_import=1 ORDER BY id').map(r => r.id);
    },
    async listConfig(table) {
      C.assertConfigTable(table);
      return all(`SELECT * FROM ${table} ORDER BY ${C.CONFIG_TABLES[table].order.join(', ')}, id`);
    },
    async createConfig(table, body) {
      C.assertConfigTable(table);
      const cols = C.CONFIG_TABLES[table].cols;
      const r = run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...C.configValues(table, body, true));
      return one(`SELECT * FROM ${table} WHERE id=?`, r.lastInsertRowid);
    },
    async updateConfig(table, id, body) {
      C.assertConfigTable(table);
      const cols = C.CONFIG_TABLES[table].cols;
      run(`UPDATE ${table} SET ${cols.map(c => `${c}=?`).join(',')} WHERE id=?`, ...C.configValues(table, body, false), id);
      return one(`SELECT * FROM ${table} WHERE id=?`, id);
    },
    async deleteConfig(table, id) {
      C.assertConfigTable(table);
      run(`DELETE FROM ${table} WHERE id=?`, id);
    },
    async close() { closeDb(); },
  };
}

module.exports = { createSqliteRepo };
