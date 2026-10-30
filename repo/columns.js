'use strict';
// Column sets returned by the repository. Both drivers must return exactly these keys.

const TRACK_COLS = [
  'id', 'name', 'file', 'zone', 'date',
  'distance', 'elevation_gain', 'elevation_loss', 'min_elevation', 'max_elevation',
  'sw_lat', 'sw_lon', 'ne_lat', 'ne_lon', 'center_lat', 'center_lon',
  'raw_count', 'clean_count', 'cleaned',
  'activity', 'province', 'ccaa', 'sierra', 'notes', 'url', 'source_confirmed',
  'road_types', 'surface_types', 'road_type_seq', 'moving_time', 'stopped_time', 'tags',
  'ibp_bicycle', 'ibp_hiking', 'ibp_running', 'circular', 'waypoints_json', 'owner_id', 'visibility',
  'days_declared', 'difficulty', 'planned',
];

const LIST_COLS = [
  'id', 'name', 'file', 'zone', 'date',
  'distance', 'elevation_gain', 'elevation_loss', 'min_elevation', 'max_elevation',
  'center_lat', 'center_lon', 'raw_count', 'clean_count', 'cleaned',
  'activity', 'province', 'ccaa', 'sierra', 'notes', 'url', 'imported_at', 'tags',
  'ibp_bicycle', 'ibp_hiking', 'ibp_running', 'is_recent_import', 'circular', 'road_types',
  'owner_id', 'visibility', 'difficulty',
];

// Fields a client may change through PATCH / bulk update.
const EDITABLE_FIELDS = new Set(['name', 'activity', 'province', 'ccaa', 'sierra', 'notes', 'url', 'tags', 'days_declared', 'difficulty', 'source_confirmed']);

const CONFIG_TABLES = {
  config_activities: { order: ['sort_order', 'name'], cols: ['name', 'color', 'keywords', 'sort_order', 'active', 'icon'] },
  config_sierras:    { order: ['name'],               cols: ['name', 'sw_lat', 'sw_lon', 'ne_lat', 'ne_lon', 'active'] },
};

// Values written for a config row on create / update (same defaults as before the repository).
function configValues(table, body, isCreate) {
  if (table === 'config_activities') {
    return isCreate
      ? [body.name, body.color || null, body.keywords || '', body.sort_order ?? 99, 1, body.icon || 'pin']
      : [body.name, body.color ?? null, body.keywords ?? '', body.sort_order ?? 0, body.active ?? 1, body.icon ?? null];
  }
  return [body.name, body.sw_lat ?? null, body.sw_lon ?? null, body.ne_lat ?? null, body.ne_lon ?? null, isCreate ? 1 : (body.active ?? 1)];
}

function assertConfigTable(table) {
  if (!CONFIG_TABLES[table]) throw new Error(`tabla de configuración desconocida: ${table}`);
}

function editableFields(fields) {
  return Object.keys(fields || {}).filter(k => EDITABLE_FIELDS.has(k) && fields[k] !== undefined);
}

module.exports = { TRACK_COLS, LIST_COLS, EDITABLE_FIELDS, CONFIG_TABLES, configValues, assertConfigTable, editableFields };
