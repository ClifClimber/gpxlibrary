'use strict';
// Author points of a user (domain/gamification.js#computeAuthorPoints) from the database.
// `db` is an openSql() instance (async get/all with ? placeholders), as used by server.js and http/public-pages.js.
const { mergeConfig, computeAuthorPoints } = require('../domain/gamification');

async function gamificationConfig(db) {
  const r = await db.get("SELECT value FROM app_settings WHERE key = 'gamification'").catch(() => null);
  let stored = null;
  try { stored = r ? JSON.parse(r.value) : null; } catch {}
  return mergeConfig(stored);
}

// Only what other users do counts (ratings, «la he hecho», comments), and only visible comments, once per person
const ROUTE_COLS = `t.id, t.name, t.notes, t.waypoints_json, t.tags, t.cover_photo_id,
  (SELECT CAST(COUNT(*) AS INTEGER) FROM track_photos p WHERE p.track_id = t.id) AS photos,
  (SELECT CAST(COALESCE(SUM(r.stars), 0) AS INTEGER) FROM track_ratings r WHERE r.track_id = t.id AND r.user_id <> t.owner_id) AS stars,
  (SELECT CAST(COUNT(*) AS INTEGER) FROM track_done d WHERE d.track_id = t.id AND d.user_id <> t.owner_id) AS done,
  (SELECT CAST(COUNT(DISTINCT c.user_id) AS INTEGER) FROM track_comments c
    WHERE c.track_id = t.id AND c.user_id <> t.owner_id AND c.hidden_at IS NULL) AS commenters`;
const COUNTS = `t.visibility = 'public' AND NOT t.planned`;

async function authorPoints(db, uid, cfg) {
  cfg = cfg || await gamificationConfig(db);
  if (!cfg.points.enabled) return computeAuthorPoints([], {}, cfg);
  const [routes, f] = await Promise.all([
    db.all(`SELECT ${ROUTE_COLS} FROM tracks t WHERE t.owner_id = ? AND ${COUNTS}`, [uid]),
    db.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM follows WHERE followee_id = ?', [uid]),
  ]);
  return computeAuthorPoints(routes, { followers: f ? f.n : 0 }, cfg);
}

// Points one route gives its owner: { points, parts } — null when it doesn't count (private, planned, no owner, disabled)
async function routePoints(db, trackId, cfg) {
  cfg = cfg || await gamificationConfig(db);
  if (!cfg.points.enabled) return null;
  const r = await db.get(`SELECT ${ROUTE_COLS} FROM tracks t WHERE t.id = ? AND t.owner_id IS NOT NULL AND ${COUNTS}`, [trackId]);
  if (!r) return null;
  const { points, parts } = computeAuthorPoints([r], {}, cfg).routes[0];
  return { points, parts };
}

module.exports = { authorPoints, routePoints };
