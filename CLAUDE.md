# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Import all GPX files from TracksGps/ into the DB (skips existing unless --force)
node scripts/import-gpx.js [--force]

# Import new files from TracksGps/_TEMP_/ (auto-classifies, geocodes, moves files)
node scripts/import-from-temp.js [--force]

# Clean/smooth raw GPS points
node scripts/clean-tracks.js [--ids 1,2,3] [--all]

# Enrich tracks with OSM road/surface data
node scripts/enrich-road-types.js [--ids 1,2,3] [--all] [--force]

# Start server at http://localhost:8080
npm start

# Start server + open browser
npm run dev
```

The viewer works only via HTTP server, not `file://`, because it uses fetch/SSE APIs.

## Architecture

Node.js HTTP server (`server.js`) with SQLite (`data/tracks.db`, auto-created). No npm runtime dependencies — uses Node.js built-ins only (`node:sqlite` requires Node v22+).

### DB — `scripts/db.js`
Singleton (`openDb()`) using `node:sqlite` (DatabaseSync). `_migrate()` uses `ALTER TABLE … ADD COLUMN` for non-breaking schema evolution. DB path: `data/tracks.db`.

Key tables: `tracks`, `raw_points`, `clean_points`, `config_activities`, `config_sierras`.

Important `tracks` columns: `activity`, `sierra`, `province`, `ccaa`, `tags` (JSON array), `road_types` (JSON obj), `surface_types` (JSON obj), `road_type_seq` (JSON array of `{t,f0,f1}` fraction segments), `waypoints_json` (JSON array of `{lat,lon,ele,name,sym,desc}`), `ibp_bicycle/hiking/running`, `circular`, `is_recent_import`.

**`track.file`** always includes the `TracksGps/` prefix. Use `path.join(ROOT, track.file)` — never `path.join(ROOT, 'TracksGps', track.file)`.

### Server — `server.js`
Pure Node.js HTTP server. No framework. Routes:
- `GET /` → `index.html` (visor)
- `GET /track?id=N` → `track.html`
- `GET /editor`, `/config`, `/admin` → static HTML pages
- `GET /api/catalog` — visor catalog (simplified points, stats, bounds, center, tags parsed, ibp rounded; same shape as the old catalog-data.js)
- `GET /api/tracks` — full track list for the editor (no points)
- `GET /api/tracks/:id` — full track (parses `tags`/`waypoints_json`, attaches `points` array from DB)
- `PATCH /api/tracks/:id` — update metadata; calls `updateGpxMetadata()` for name/activity/notes
- `DELETE /api/tracks/:id`
- `GET /api/geo` — returns `{provinces, ccaa, zones}` distinct values from DB
- `GET /api/config/activities` — activity list with colors
- `GET /api/db/import-temp` (SSE) — runs `import-from-temp.js`, streams log lines
- `GET /api/db/enrich-road-types?ids=1,2,3` (SSE) — runs `enrich-road-types.js`
- `GET /api/db/clean?ids=…` (SSE) — runs `clean-tracks.js`
- `/api/admin/…` — stats, backup, restore, vacuum, integrity

### Pages
- `/` → `index.html` + `visor.js` + `visor.css` — Leaflet map, track list, filters, elevation profile
- `/track?id=N` → `track.html` + `track.css` — detail view with tabs (Resumen, Puntos de paso, Tipos de camino, Subidas, Tiempo hoy)
- `/editor` → `editor.html` — CRUD list, import from `_TEMP_`, tag editing
- `/config` → `config.html` — activity/sierra config
- `/admin` → `admin.html` — backup/restore/vacuum, IBP calc, stats

### Visor (`visor.js`)
- Loads track data by fetching `GET /api/catalog` asynchronously at startup (async IIFE). No longer depends on the global `catalog-data.js` file.
- Polylines are only added to the map when active or being previewed (hover). When a track is active, other tracks' polylines are suppressed — `previewTrack` is a no-op when `activeIdx !== null`.
- `activateTrack(i, fitMap)` manages the active polyline + highlights the list row (`.track-item.active`).
- Filters live in chips + popovers; `applyFilters()` shows/hides markers and updates the list.
- `geoFilter` — Nominatim place search sets a radius circle filter.

### Track detail (`track.html`)
Tabs built dynamically by `buildContent(t)`:
- **Resumen** — key stats, IBP gauge, tags, description
- **Puntos de paso** — start/end points + GPX waypoints (`t.waypoints[]`) with toggle button to show `L.divIcon` markers on the map (`toggleWptMarkers()`)
- **Tipos de camino** — OSM highway/surface breakdown; clicking a type highlights its segments on the map (`showRoadTypesOnMap()`, `highlightRoadType()`)
- **Subidas** — gradient color overlay on map (`showGradientMap()`), detected climbs listed
- **Tiempo hoy** — Open-Meteo forecast

Edit modal: `<datalist>` autocomplete for activity/sierra/province/ccaa; custom dropdown for tags.

### Import pipeline (`scripts/import-from-temp.js`)
1. Parse GPX (track points + `<wpt>` waypoints)
2. Nominatim reverse-geocode for province/CCAA
3. Infer activity from name keywords + metrics
4. Move file to `TracksGps/<Activity>/<Sierra>/`
5. Upsert to DB; store `waypoints_json`; write metadata back to GPX

### OSM enrichment (`scripts/enrich-road-types.js`)
Queries Overpass API for `highway` ways inside track bbox. Matches each GPS segment midpoint to nearest way. Stores compact fraction-based segments `{t, f0, f1}` in `road_type_seq` for the frontend to colorize.

## Design system — `shared.css` (MANDATORY for every page)

Every page must `<link rel="stylesheet" href="/shared.css">` before its own CSS. Never hard-code colors — use CSS variables (`--ink`, `--ink-2`, `--muted`, `--soft`, `--line`, `--surface`, `--bg`, `--accent`, `--accent-soft`, `--success`, `--warn`, `--danger`, `--radius`, `--shadow`, etc.).

Key component classes: `.btn` (+ modifiers), `.input`/`.select`, `.chip` (+ `.active`, `.open`), `.popover`, `.cat-pills`/`.cat-pill`, `.table`, `.stats-grid`/`.stat`, `.tag`, `.badge`, `.modal-overlay`/`.modal`, `.log-box`, `.floating`, `.card`.

New pages start from `docs/page-template.html` and must be added to the `<nav>` in every page.

## GPX conventions
- Source tracks live in `TracksGps/<Activity>/<Zone>/file.gpx`. Never modify them programmatically except via `updateGpxMetadata()`.
- Files with `YYYY-MM-DD` filename prefix get that date if no `<time>` tag is present.
- Files with only `<wpt>` (no `<trkpt>`) are skipped by the import scripts.
- `<wpt>` waypoints are parsed (lat/lon/ele/name/sym/desc) and stored as `waypoints_json`.
