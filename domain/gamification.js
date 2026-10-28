'use strict';
// Gamification: achievement families, XP/level and multi-day route detection.
// Every number here is only a default: the admin can override it (stored in app_settings,
// key 'gamification') and the server deep-merges the stored config over DEFAULT_CONFIG.

const TIER_NAMES = ['Bronce', 'Plata', 'Oro', 'Platino', 'Leyenda'];

const DEFAULT_CONFIG = {
  xp: {
    perKm: 1,          // XP per km of completed routes
    gainPerXp: 50,     // metres of ascent per 1 XP
    perTier: 100,      // XP per achievement tier reached
    levelBase: 100,    // level n needs levelBase·(n-1)² XP
  },
  multiDay: {
    enabled: true,
    excludeFromRecords: true,   // don't count for "longest route" / "biggest climb in one route"
    excludeFromTotals: false,   // don't count for totals (km, ascent, routes, provinces…)
    // From the recording sessions (tracks.time_segments) when the GPX has times:
    overnightGapHours: 6,       // a stop this long splits two days of activity
    maxGapHours: 96,            // a longer jump means files glued together → times are ignored
    minDayKm: 1,                // a "day" needs at least this distance to count
    maxContinuousHours: 18,     // one session longer than this (GPS left on overnight) spans several days
    maxDayHours: 12,            // estimated effort hours above which a route is multi-day
    maxMovingHours: 12,         // measured moving time above which a route is multi-day
    keywords: '\\b(\\d+|dos|tres|cuatro|cinco|seis|siete|ocho)\\s*(etapas|d[ií]as|jornadas)\\b|bikepacking|traves[ií]a de \\d+',
    // Effort estimate per activity group: hours = km / kmh + ascent / climbMh
    groups: [
      { id: 'road', name: 'Carretera',     kmh: 22,  climbMh: 900, activities: ['Ciclismo de carretera'] },
      { id: 'bike', name: 'BTT / Gravel',  kmh: 16,  climbMh: 800, activities: ['MTB', 'MTB Enduro', 'Gravel', 'Bikepacking'] },
      { id: 'run',  name: 'Correr',        kmh: 8,   climbMh: 700, activities: ['Trail Running', 'Running'] },
      { id: 'foot', name: 'A pie (resto)', kmh: 4.5, climbMh: 500, activities: [] },   // default group
    ],
  },
  families: [
    { id: 'routes',     icon: 'footprints', name: 'Rutas completadas',          unit: 'rutas',       enabled: true, tiers: [1, 10, 50, 100, 250] },
    { id: 'km',         icon: 'ruler', name: 'Kilómetros recorridos',      unit: 'km',          enabled: true, tiers: [100, 500, 1000, 5000, 10000] },
    { id: 'gain',       icon: 'mountain', name: 'Desnivel acumulado',         unit: 'm',           enabled: true, tiers: [1000, 8849, 50000, 100000, 300000] },
    { id: 'max_km',     icon: 'flag', name: 'Ruta más larga (en un día)', unit: 'km',          enabled: true, tiers: [21, 42, 70, 100, 150] },
    { id: 'max_gain',   icon: 'trending-up', name: 'Mayor desnivel en un día',   unit: 'm',           enabled: true, tiers: [500, 1000, 1500, 2000, 3000] },
    { id: 'multiday',   icon: 'tent', name: 'Travesías de varios días',   unit: 'travesías',   enabled: true, tiers: [1, 3, 5, 10, 20] },
    { id: 'provinces',  icon: 'map', name: 'Provincias exploradas',      unit: 'provincias',  enabled: true, tiers: [2, 5, 10, 20, 35] },
    { id: 'activities', icon: 'layers', name: 'Multideporte',               unit: 'actividades', enabled: true, tiers: [2, 3, 5, 7, 9] },
    { id: 'circular',   icon: 'loop', name: 'Rutas circulares',           unit: 'rutas',       enabled: true, tiers: [5, 25, 50, 100, 200] },
    { id: 'years',      icon: 'calendar', name: 'Años en ruta',               unit: 'años',        enabled: true, tiers: [1, 3, 5, 10, 20] },
    { id: 'photos',     icon: 'camera', name: 'Fotógrafo',                  unit: 'fotos',       enabled: true, tiers: [1, 10, 25, 100, 250] },
    { id: 'lists',      icon: 'books', name: 'Coleccionista',              unit: 'listas',      enabled: true, tiers: [1, 3, 5, 10, 20] },
  ],
};

const clone = o => JSON.parse(JSON.stringify(o));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);

/** Stored (partial) config deep-merged over the defaults; families and groups merge by id. */
function mergeConfig(stored) {
  const cfg = clone(DEFAULT_CONFIG);
  if (!stored || typeof stored !== 'object') return cfg;
  if (stored.xp) for (const k of Object.keys(cfg.xp)) cfg.xp[k] = num(stored.xp[k], cfg.xp[k]);
  const md = stored.multiDay || {};
  for (const k of ['enabled', 'excludeFromRecords', 'excludeFromTotals']) if (typeof md[k] === 'boolean') cfg.multiDay[k] = md[k];
  for (const k of ['overnightGapHours', 'maxGapHours', 'minDayKm', 'maxContinuousHours', 'maxDayHours', 'maxMovingHours']) cfg.multiDay[k] = num(md[k], cfg.multiDay[k]);
  if (typeof md.keywords === 'string') cfg.multiDay.keywords = md.keywords;
  for (const g of md.groups || []) {
    const cur = cfg.multiDay.groups.find(x => x.id === g.id);
    if (!cur) continue;
    cur.kmh = num(g.kmh, cur.kmh); cur.climbMh = num(g.climbMh, cur.climbMh);
    if (Array.isArray(g.activities)) cur.activities = g.activities.map(String).map(s => s.trim()).filter(Boolean);
  }
  for (const f of stored.families || []) {
    const cur = cfg.families.find(x => x.id === f.id);
    if (!cur) continue;
    if (typeof f.enabled === 'boolean') cur.enabled = f.enabled;
    if (typeof f.name === 'string' && f.name.trim()) cur.name = f.name.trim();
    // Configs saved before the icon library keep the old default emoji: those switch to the new icon
    if (typeof f.icon === 'string' && f.icon.trim() && f.icon.trim() !== LEGACY_ICONS[f.id]) cur.icon = f.icon.trim();
    if (Array.isArray(f.tiers) && f.tiers.length === 5) cur.tiers = f.tiers.map((t, i) => num(t, cur.tiers[i]));
  }
  return cfg;
}

const LEGACY_ICONS = { routes: '🥾', km: '📏', gain: '⛰️', max_km: '🏁', max_gain: '🧗', multiday: '🏕️',
  provinces: '🗺️', activities: '🎽', circular: '🔄', years: '📅', photos: '📷', lists: '📚' };

/** Throws a readable error if the config can't be used. */
function validateConfig(cfg) {
  for (const f of cfg.families) {
    if (!f.tiers.every(t => t > 0)) throw new Error(`«${f.name}»: los umbrales deben ser positivos`);
    if (!f.tiers.every((t, i) => i === 0 || t > f.tiers[i - 1])) throw new Error(`«${f.name}»: los umbrales deben ir de menor a mayor`);
  }
  for (const g of cfg.multiDay.groups) if (!(g.kmh > 0 && g.climbMh > 0)) throw new Error(`Grupo «${g.name}»: velocidad y ritmo de subida deben ser > 0`);
  const m = cfg.multiDay;
  if (!(m.maxDayHours > 0 && m.maxMovingHours > 0 && m.overnightGapHours > 0 && m.maxContinuousHours > 0)) throw new Error('Las horas deben ser > 0');
  if (!(m.maxGapHours > m.overnightGapHours)) throw new Error('El hueco máximo debe ser mayor que la parada nocturna');
  if (!(m.minDayKm >= 0)) throw new Error('Los km mínimos por día no pueden ser negativos');
  if (!(cfg.xp.levelBase > 0 && cfg.xp.gainPerXp > 0)) throw new Error('Parámetros de XP no válidos');
  try { new RegExp(cfg.multiDay.keywords, 'i'); } catch (e) { throw new Error('Palabras clave: expresión no válida (' + e.message + ')'); }
  return cfg;
}

function groupFor(activity, cfg) {
  const gs = cfg.multiDay.groups;
  return gs.find(g => g.activities.includes(activity)) || gs.find(g => g.id === 'foot') || gs[gs.length - 1];
}

/** Days with activity from the recording sessions; null when the times can't be trusted. */
function activeDays(segs, md) {
  if (!Array.isArray(segs) || !segs.length) return null;
  const gapsH = segs.slice(1).map((s, i) => (s.s - segs[i].e) / 3600);
  if (gapsH.some(h => h > md.maxGapHours || h < 0)) return null;   // glued files / clock jumps
  // Group sessions into days (split at overnight stops); a group spanning more than maxContinuousHours
  // (GPS left on in the hut) counts as the number of calendar days it covers, at least two.
  let days = 0, dayKm = 0, dayStart = segs[0].s, dayEnd = segs[0].e;
  const close = () => {
    if (dayKm < md.minDayKm) return;
    const spanH = (dayEnd - dayStart) / 3600;
    days += spanH > md.maxContinuousHours ? Math.max(2, Math.ceil(spanH / 24)) : 1;
  };
  segs.forEach((s, i) => {
    if (i > 0 && gapsH[i - 1] >= md.overnightGapHours) { close(); dayKm = 0; dayStart = s.s; }
    dayKm += Number(s.km) || 0;
    dayEnd = s.e;
  });
  close();
  return Math.max(1, days);
}

/**
 * Effort estimate and verdict for one track ({name, activity, distance, elevation_gain, moving_time,
 * time_segments}). Trustworthy recording times decide on their own (days with activity); otherwise:
 * name keywords, then moving time (it leaves out pauses over 5 min, so it can't prove a single day),
 * then the effort estimate for the activity group.
 */
function multiDayInfo(t, cfg) {
  const md = cfg.multiDay;
  const g = groupFor(t.activity, cfg);
  const km = Number(t.distance) || 0, gain = Number(t.elevation_gain) || 0;
  const estHours = km / g.kmh + gain / g.climbMh;
  const movingHours = t.moving_time ? Number(t.moving_time) / 3600 : null;
  let segs = t.time_segments;
  if (typeof segs === 'string') { try { segs = JSON.parse(segs); } catch { segs = null; } }
  const elapsedHours = Array.isArray(segs) && segs.length ? (segs[segs.length - 1].e - segs[0].s) / 3600 : null;
  const r1 = n => (n == null ? null : Math.round(n * 10) / 10);
  const days = activeDays(segs, md);
  // What the user declared when uploading/editing wins: 1 one day · N days · 0 several (no number)
  if (t.days_declared != null && t.days_declared !== '') {
    const dd = Number(t.days_declared);
    const multiDay = md.enabled && dd !== 1;
    const guess = days && days >= 2 ? days : Math.max(2, Math.ceil(estHours / md.maxDayHours));
    return { multiDay, reason: multiDay ? 'declarado' : null, group: g.id, estHours: r1(estHours),
             movingHours: r1(movingHours), elapsedHours: r1(elapsedHours), timesTrusted: days != null,
             declared: dd, estDays: dd >= 2 ? dd : dd === 0 ? guess : 1 };
  }
  if (days != null) {
    const multiDay = md.enabled && days >= 2;
    return { multiDay, reason: multiDay ? 'días con actividad' : null, group: g.id, estHours: r1(estHours),
             movingHours: r1(movingHours), elapsedHours: r1(elapsedHours), timesTrusted: true, estDays: days };
  }
  let reason = null;
  if (md.keywords) {
    try { if (new RegExp(md.keywords, 'i').test(t.name || '')) reason = 'nombre'; } catch {}
  }
  if (!reason && movingHours != null && movingHours > md.maxMovingHours) reason = 'tiempo en movimiento';
  if (!reason && estHours > md.maxDayHours) reason = 'distancia y desnivel';
  const multiDay = md.enabled && !!reason;
  return { multiDay, reason: multiDay ? reason : null, group: g.id, estHours: r1(estHours),
           movingHours: r1(movingHours), elapsedHours: r1(elapsedHours), timesTrusted: false,
           estDays: multiDay ? Math.max(2, Math.ceil(estHours / md.maxDayHours)) : 1 };
}

/**
 * Achievements and XP for one user.
 * tracks: completed (non-planned) tracks with distance, elevation_gain, activity, moving_time, name,
 *         province, circular, date. extra: { photos, lists }.
 */
function computeAchievements(tracks, extra, cfg) {
  const md = cfg.multiDay;
  const info = tracks.map(t => ({ t, ...multiDayInfo(t, cfg) }));
  const forTotals  = info.filter(x => !(x.multiDay && md.excludeFromTotals)).map(x => x.t);
  const forRecords = info.filter(x => !(x.multiDay && md.excludeFromRecords)).map(x => x.t);
  const sum = (arr, k) => arr.reduce((s, t) => s + (Number(t[k]) || 0), 0);
  const max = (arr, k) => arr.reduce((m, t) => Math.max(m, Number(t[k]) || 0), 0);
  const distinct = (arr, fn) => new Set(arr.map(fn).filter(Boolean)).size;
  const values = {
    routes:     forTotals.length,
    km:         Math.round(sum(forTotals, 'distance')),
    gain:       Math.round(sum(forTotals, 'elevation_gain')),
    max_km:     Math.round(max(forRecords, 'distance') * 10) / 10,
    max_gain:   Math.round(max(forRecords, 'elevation_gain')),
    multiday:   info.filter(x => x.multiDay).length,
    provinces:  distinct(forTotals, t => t.province),
    activities: distinct(forTotals, t => t.activity),
    circular:   forTotals.filter(t => Number(t.circular) === 1 || t.circular === true).length,
    years:      distinct(forTotals, t => (t.date && String(t.date).length >= 4 ? String(t.date).slice(0, 4) : null)),
    photos:     Number(extra?.photos) || 0,
    lists:      Number(extra?.lists) || 0,
  };
  const families = cfg.families.filter(f => f.enabled);
  const achievements = families.map(f => {
    const value = values[f.id] ?? 0;
    const level = f.tiers.filter(t => value >= t).length;
    const next = f.tiers[level] ?? null;
    const prev = level ? f.tiers[level - 1] : 0;
    return { id: f.id, icon: f.icon, name: f.name, unit: f.unit, value, level, tier: level ? TIER_NAMES[level - 1] : null,
             next, progress: next ? Math.min(1, (value - prev) / (next - prev)) : 1, max: level === f.tiers.length };
  });
  const x = cfg.xp;
  const xp = Math.round(values.km * x.perKm + values.gain / x.gainPerXp + achievements.reduce((s, a) => s + a.level * x.perTier, 0));
  const level = Math.floor(Math.sqrt(xp / x.levelBase)) + 1;
  return {
    xp, level, xpCur: (level - 1) ** 2 * x.levelBase, xpNext: level ** 2 * x.levelBase,
    unlocked: achievements.reduce((s, a) => s + a.level, 0), total: families.length * 5,
    achievements,
    multiDayRoutes: info.filter(x => x.multiDay).map(x => ({ id: x.t.id, name: x.t.name, reason: x.reason, estDays: x.estDays })),
  };
}

module.exports = { DEFAULT_CONFIG, TIER_NAMES, mergeConfig, validateConfig, multiDayInfo, computeAchievements };
