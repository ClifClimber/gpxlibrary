'use strict';

// Usa node:sqlite (nativo en Node.js v22+, sin dependencias externas)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const fs = require('fs');
const { SQLITE_PATH } = require('../config');
const DB_PATH = SQLITE_PATH;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db;

function openDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _initSchema(_db);
  _migrate(_db);
  return _db;
}

// Helper para transacciones (node:sqlite no tiene db.transaction())
function withTransaction(fn) {
  _db.exec('BEGIN');
  try {
    const r = fn();
    _db.exec('COMMIT');
    return r;
  } catch (e) {
    try { _db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

const DEFAULT_ACTIVITIES = [
  { name: 'Mtb',                   color: '#7c3aed', keywords: 'mtb,mountain bike,btt',           sort_order: 1 },
  { name: 'Gravel',                color: '#b45309', keywords: 'gravel',                           sort_order: 2 },
  { name: 'Bikepacking',           color: '#92400e', keywords: 'bikepacking',                      sort_order: 3 },
  { name: 'Ciclismo de carretera', color: '#0369a1', keywords: 'carretera,ciclism',                sort_order: 4 },
  { name: 'Trail Running',         color: '#0284c7', keywords: 'trail run,running,trail.?run',     sort_order: 5 },
  { name: 'Running',               color: '#0ea5e9', keywords: '',                                 sort_order: 6 },
  { name: 'Senderismo',            color: '#16a34a', keywords: 'senderism,caminata,camino',        sort_order: 7 },
  { name: 'Escalada',              color: '#dc2626', keywords: 'escalad,climbing',                 sort_order: 8 },
  { name: 'Esquí de montaña',      color: '#0e7490', keywords: 'esquí,esqui,ski',                  sort_order: 9 },
  { name: 'Kayak',                 color: '#0891b2', keywords: 'kayak,pirag',                      sort_order: 10 },
  { name: 'Otro',                  color: '#6b7280', keywords: '',                                 sort_order: 11 },
];

const DEFAULT_SIERRAS = [
  { name: 'Sierra de Gredos',       sw_lat: 39.75, sw_lon: -6.1,  ne_lat: 40.65, ne_lon: -4.3  },
  { name: 'Sierra de Guadarrama',   sw_lat: 40.55, sw_lon: -4.35, ne_lat: 41.05, ne_lon: -3.65 },
  { name: 'Sierra Norte de Madrid', sw_lat: 40.9,  sw_lon: -3.85, ne_lat: 41.35, ne_lon: -3.15 },
  { name: 'Sierra de Béjar',        sw_lat: 40.15, sw_lon: -5.95, ne_lat: 40.55, ne_lon: -5.35 },
  { name: 'Sierra de Gata',         sw_lat: 40.0,  sw_lon: -7.05, ne_lat: 40.35, ne_lon: -6.05 },
  { name: 'Pirineos',               sw_lat: 42.0,  sw_lon: -2.0,  ne_lat: 43.5,  ne_lon: 3.3   },
  { name: 'Sierra Nevada',          sw_lat: 36.85, sw_lon: -3.6,  ne_lat: 37.35, ne_lon: -2.75 },
  { name: 'Picos de Europa',        sw_lat: 43.05, sw_lon: -5.1,  ne_lat: 43.45, ne_lon: -4.4  },
  { name: 'Cordillera Cantábrica',  sw_lat: 42.7,  sw_lon: -7.3,  ne_lat: 43.6,  ne_lon: -2.8  },
  { name: 'Montes de Toledo',       sw_lat: 39.0,  sw_lon: -5.6,  ne_lat: 39.9,  ne_lon: -3.4  },
  { name: 'Sierra Morena',          sw_lat: 37.4,  sw_lon: -7.1,  ne_lat: 38.6,  ne_lon: -2.3  },
  { name: 'Sistema Ibérico',        sw_lat: 39.8,  sw_lon: -2.9,  ne_lat: 42.1,  ne_lon: -1.0  },
  { name: 'Serra de Tramuntana',    sw_lat: 39.6,  sw_lon: 2.35,  ne_lat: 39.95, ne_lon: 3.15  },
  { name: 'Galicia',                sw_lat: 41.8,  sw_lon: -8.9,  ne_lat: 43.8,  ne_lon: -6.35 },
  { name: 'Sierra de Cazorla',      sw_lat: 37.45, sw_lon: -3.4,  ne_lat: 38.45, ne_lon: -2.35 },
  { name: 'Montes de León',         sw_lat: 42.1,  sw_lon: -6.8,  ne_lat: 43.0,  ne_lon: -5.8  },
  { name: 'Sierra de Ayllón',       sw_lat: 41.0,  sw_lon: -3.7,  ne_lat: 41.35, ne_lon: -2.8  },
  { name: 'Sierra de la Demanda',   sw_lat: 41.7,  sw_lon: -3.4,  ne_lat: 42.35, ne_lon: -2.7  },
  { name: 'Serra del Montseny',     sw_lat: 41.65, sw_lon: 2.2,   ne_lat: 41.9,  ne_lon: 2.7   },
];

function _migrate(db) {
  const newCols = [
    ['activity',          'TEXT'],
    ['province',          'TEXT'],
    ['ccaa',              'TEXT'],
    ['sierra',            'TEXT'],
    ['notes',             'TEXT'],
    ['url',               'TEXT'],
    ['road_types',        'TEXT'],
    ['surface_types',     'TEXT'],
    ['road_types_at',     'TEXT'],
    ['moving_time',       'INTEGER'],
    ['stopped_time',      'INTEGER'],
    ['tags',              'TEXT'],
    ['ibp_bicycle',       'REAL'],
    ['ibp_hiking',        'REAL'],
    ['ibp_running',       'REAL'],
    ['is_recent_import',  'INTEGER DEFAULT 0'],
    ['circular',          'INTEGER DEFAULT 0'],
    ['road_type_seq',     'TEXT'],
    ['waypoints_json',    'TEXT'],
    ['catalog_pts',       'TEXT'],
    ['uid',               'TEXT'],   // stable storage key: TracksGps/store/{uid}.gpx
    ['sha256',            'TEXT'],   // hash of the original GPX bytes, for de-duplication
  ];
  for (const [col, type] of newCols) {
    try { db.exec(`ALTER TABLE tracks ADD COLUMN ${col} ${type}`); } catch {}
  }
  ['activity','province','ccaa','sierra'].forEach(c => {
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_${c} ON tracks(${c})`); } catch {}
  });
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_uid ON tracks(uid) WHERE uid IS NOT NULL'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_sha256 ON tracks(sha256)'); } catch {}

  // Job queue (queue/): same columns as repo/pg/002_jobs.sql
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'queued',
      attempts     INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      run_at       TEXT NOT NULL DEFAULT (datetime('now')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      started_at   TEXT,
      finished_at  TEXT,
      heartbeat_at TEXT,
      locked_by    TEXT,
      error        TEXT,
      result       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_at);
    CREATE TABLE IF NOT EXISTS job_logs (
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      seq    INTEGER NOT NULL,
      level  TEXT NOT NULL,
      text   TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    );
  `);

  // One-time: compute circular from first/last raw point for all tracks
  // Uses flat-earth approximation: cos(40°)^2 ≈ 0.41, 0.5km ≈ 0.0045 deg
  try {
    db.exec(`
      UPDATE tracks SET circular = (
        SELECT CASE WHEN (
          (p1.lat - p2.lat)*(p1.lat - p2.lat) +
          (p1.lon - p2.lon)*(p1.lon - p2.lon)*0.41
        ) < 0.00002025 THEN 1 ELSE 0 END
        FROM raw_points p1
        JOIN raw_points p2 ON p2.track_id = p1.track_id
        WHERE p1.track_id = tracks.id
          AND p1.seq = 0
          AND p2.seq = (SELECT MAX(seq) FROM raw_points WHERE track_id = tracks.id)
          AND p1.seq != p2.seq
      )
      WHERE id IN (SELECT DISTINCT track_id FROM raw_points)
    `);
  } catch {}

  // Eliminar columna category si todavía existe
  try {
    const cols = db.prepare('PRAGMA table_info(tracks)').all();
    if (cols.some(c => c.name === 'category')) {
      try { db.exec('DROP INDEX IF EXISTS idx_tracks_category'); } catch {}
      db.exec('ALTER TABLE tracks DROP COLUMN category');
    }
  } catch {}

  // Seed config tables if empty
  const actCount = db.prepare('SELECT COUNT(*) as n FROM config_activities').get().n;
  if (actCount === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO config_activities (name,color,keywords,sort_order) VALUES (?,?,?,?)');
    for (const a of DEFAULT_ACTIVITIES) ins.run(a.name, a.color, a.keywords, a.sort_order);
  }
  const sieCount = db.prepare('SELECT COUNT(*) as n FROM config_sierras').get().n;
  if (sieCount === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO config_sierras (name,sw_lat,sw_lon,ne_lat,ne_lon) VALUES (?,?,?,?,?)');
    for (const s of DEFAULT_SIERRAS) ins.run(s.name, s.sw_lat, s.sw_lon, s.ne_lat, s.ne_lon);
  }
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      file           TEXT UNIQUE NOT NULL,
      zone           TEXT,
      date           TEXT,
      distance       REAL,
      elevation_gain INTEGER,
      elevation_loss INTEGER,
      min_elevation  INTEGER,
      max_elevation  INTEGER,
      sw_lat REAL, sw_lon REAL, ne_lat REAL, ne_lon REAL,
      center_lat REAL, center_lon REAL,
      raw_count      INTEGER NOT NULL DEFAULT 0,
      clean_count    INTEGER,
      cleaned        INTEGER NOT NULL DEFAULT 0,
      color          TEXT,
      imported_at    TEXT NOT NULL DEFAULT (datetime('now')),
      cleaned_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_points (
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      seq      INTEGER NOT NULL,
      lat      REAL NOT NULL,
      lon      REAL NOT NULL,
      ele      REAL,
      PRIMARY KEY (track_id, seq)
    );

    CREATE TABLE IF NOT EXISTS clean_points (
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      seq      INTEGER NOT NULL,
      lat      REAL NOT NULL,
      lon      REAL NOT NULL,
      ele      REAL,
      PRIMARY KEY (track_id, seq)
    );

    CREATE TABLE IF NOT EXISTS category_colors (
      category   TEXT PRIMARY KEY,
      color      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config_activities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      color      TEXT,
      keywords   TEXT,
      sort_order INTEGER DEFAULT 0,
      active     INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS config_sierras (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT UNIQUE NOT NULL,
      sw_lat     REAL,
      sw_lon     REAL,
      ne_lat     REAL,
      ne_lon     REAL,
      active     INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_date      ON tracks(date);
    CREATE INDEX IF NOT EXISTS idx_raw_points_track ON raw_points(track_id);
    CREATE INDEX IF NOT EXISTS idx_cln_points_track ON clean_points(track_id);
  `);
}

function closeDb() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

module.exports = { openDb, closeDb, withTransaction, DB_PATH };
