# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Import new files from TracksGps/_TEMP_/ into the store (classifies, geocodes, skips duplicates)
node scripts/import-from-temp.js [--force]

# Unit tests of the pure domain logic (node:test, no dependencies)
npm test

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

### Domain — `domain/`
Pure functions with no database, filesystem or network access (phase 1 of the cloud plan): `gpx-parse` (GPX text → name/date/url/points/waypoints), `metrics` (distance, elevation with 8 m noise threshold, bounds, circular, moving/stopped time), `classify` (activity inference, sierra by bbox, Nominatim parsing), `ibp`, `simplify` (even sampling, catalog polyline, GPS cleaning filters) and `gpx-export` (build GPX, apply metadata). Scripts and `server.js` must import from `./domain` instead of re-implementing these; tests live in `domain/*.test.js`.

Node.js HTTP server (`server.js`) with SQLite (`data/tracks.db`, auto-created). No npm runtime dependencies — uses Node.js built-ins only (`node:sqlite` requires Node v22+).

### DB — `scripts/db.js`
Singleton (`openDb()`) using `node:sqlite` (DatabaseSync). `_migrate()` uses `ALTER TABLE … ADD COLUMN` for non-breaking schema evolution. DB path: `data/tracks.db`.

Key tables: `tracks`, `raw_points`, `clean_points`, `config_activities`, `config_sierras`.

Important `tracks` columns: `activity`, `sierra`, `province`, `ccaa`, `tags` (JSON array), `road_types` (JSON obj), `surface_types` (JSON obj), `road_type_seq` (JSON array of `{t,f0,f1}` fraction segments), `waypoints_json` (JSON array of `{lat,lon,ele,name,sym,desc}`), `ibp_bicycle/hiking/running`, `circular`, `is_recent_import`.

**`track.file`** always includes the `TracksGps/` prefix. Use `path.join(ROOT, track.file)` — never `path.join(ROOT, 'TracksGps', track.file)`. Since the store migration it is `TracksGps/store/{uid}.gpx` (see `scripts/store.js`); `uid` and `sha256` columns identify the stored original.

### Server — `server.js`
Pure Node.js HTTP server. No framework. Routes:
- `GET /` → `index.html` (visor)
- `GET /track?id=N` → `track.html`
- `GET /trazar[?id=N]` → `trazar.html` (draw a new route or edit a copy of track N)
- `GET /editor`, `/admin` → static HTML pages (`/config` redirects to `/admin#activities`)
- `GET /api/catalog` — visor catalog (simplified points, stats, bounds, center, tags parsed, ibp rounded; same shape as the old catalog-data.js)
- `GET /api/tracks` — full track list for the editor (no points)
- `GET /api/tracks/:id` — full track (parses `tags`/`waypoints_json`, attaches `points` array from DB, downsampled to 800 unless `?full=1`)
- `PATCH /api/tracks/:id` — update metadata in the DB only (files are never moved or rewritten)
- `DELETE /api/tracks/:id`
- `GET /api/geo` — returns `{provinces, ccaa, zones}` distinct values from DB
- `GET /api/config/activities` — activity list with colors
- `POST /api/db/import-temp` (SSE) — runs `import-from-temp.js`, streams log lines
- `POST /api/db/enrich-road-types?ids=1,2,3` (SSE) — runs `enrich-road-types.js`
- `POST /api/db/clean?ids=…` (SSE) — runs `clean-tracks.js`
- `POST /api/import/wikiloc` (SSE) — body `{ url }`, runs `wikiloc-import.js`; requires `wikiloc_token` in `osm-settings.json`
- `GET /api/config/settings` — returns `osm-settings.json` (token values masked)
- `PATCH /api/config/settings` — updates allowed keys (`wikiloc_token`) in `osm-settings.json`
- `/api/admin/…` — stats, backup, restore, vacuum, integrity

### Pages
- `/` → `index.html` + `visor.js` + `visor.css` — Leaflet map, track list, filters, elevation profile
- `/track?id=N` → `track.html` + `track.css` — detail view with tabs (Resumen, Puntos de paso, Tipos de camino, Subidas, Tiempo hoy)
- `/editor` → `editor.html` — CRUD list, import from `_TEMP_`, tag editing
- `/admin` → `admin.html` — tabs: Base de datos (backup/restore/vacuum, stats), Gestión de Tracks, Actividades, Sierras / Zonas, Provincias & CCAA, Parámetros (climb thresholds + Wikiloc token), Logs, Acerca de. Tabs are deep-linkable via `#tab` (e.g. `/admin#params`).
- `/trazar` → `trazar.html` — route drawing/editing (draw, drag/insert/delete vertices, trim, waypoints, join other tracks, undo). `?join=1,2` opens several tracks joined in order (used by Comparar → Unir). Optional trail snapping via BRouter (brouter.de) and elevation via Open-Meteo. Saving builds a GPX client-side, uploads it with `/api/import/upload`, runs `/api/db/import-temp`, then PATCHes activity/notes. Editing an existing track always saves a new copy — source GPX files are never rewritten.

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
- **Subidas** — detected climbs shown automatically on map (colored polylines, no labels) and as colored bands in the elevation profile SVG when the tab is active. Toggle button to show/hide. Clicking a climb zooms the map and highlights a selection rect in the profile. `gSubidasActive` flag tracks whether the tab is active; `showClimbsOnMap()` / `showClimbsOnProfile()` / `clearClimbBands()` manage the overlays.
- **Tiempo hoy** — Open-Meteo forecast

Climb detection (`detectClimbs`): thresholds read from `localStorage['gpx-climb-params']` (minGain m, minGrad %, minDist km). A climb passes if `dist ≥ minDist AND (gain ≥ minGain OR grad ≥ minGrad)`. Defaults: 80 m / 4% / 0.2 km.

`gradColor(pct)`: green < 3%, yellow < 6%, orange < 9%, red < 12%, dark-red ≥ 12%. No purple.

Profile globals: `gEleDists` (cumulative distances for `gElePts`) and `gProfileParams` (`{l,t,CW,CH,totalDist}`) are set in `drawProfile` and used by climb/selection highlight functions.

Edit modal: `<datalist>` autocomplete for activity/sierra/province/ccaa; custom dropdown for tags.

### Import pipeline (`scripts/import-from-temp.js`)
1. Parse GPX (track points + `<wpt>` waypoints)
2. Nominatim reverse-geocode for province/CCAA
3. Infer activity from name keywords + metrics
4. Skip if the SHA-256 of the file already exists in the DB (byte-identical duplicate); otherwise store it as `TracksGps/store/{uid}.gpx`. Low-confidence tracks get the tag `revisar`
5. Upsert to DB; store `waypoints_json`, `uid`, `sha256`

### Wikiloc import (`scripts/wikiloc-import.js`)
Takes a Wikiloc URL or numeric trail ID. Reads `wikiloc_token` from `osm-settings.json`. Calls Wikiloc REST API v2 (`/api/v2/trails/{id}` and `/api/v2/trails/{id}/gpx`) with Bearer auth. Saves GPX to `TracksGps/_TEMP_/wikiloc-{id}.gpx`, then spawns `import-from-temp.js` to complete the import. Token configured in `Admin → Parámetros → Wikiloc`.

The visor has a globe icon button in `#panel-head` that opens an import modal. Currently lists Wikiloc; designed to add more sources (Komoot, Strava…) as new `.import-net-btn` cards.

### OSM enrichment (`scripts/enrich-road-types.js`)
Queries Overpass API for `highway` ways inside track bbox. Matches each GPS segment midpoint to nearest way. Stores compact fraction-based segments `{t, f0, f1}` in `road_type_seq` for the frontend to colorize.

## Design system — `shared.css` (MANDATORY for every page)

Every page must `<link rel="stylesheet" href="/shared.css">` followed by `<script src="/theme.js"></script>` (applies light/dark theme before paint and adds the nav toggle). Dark mode works by redefining the tokens, so never hard-code neutral colors — for surfaces that use the ink color as a background (primary buttons, active chips/tabs, toasts) use `--solid` / `--on-solid`, and for tinted backgrounds use `color-mix(in srgb, <hue> N%, transparent)` instead of light pastel hex. Use CSS variables (`--ink`, `--ink-2`, `--muted`, `--soft`, `--line`, `--surface`, `--bg`, `--accent`, `--accent-soft`, `--success`, `--warn`, `--danger`, `--radius`, `--shadow`, etc.).

Key component classes: `.btn` (+ modifiers), `.input`/`.select`, `.chip` (+ `.active`, `.open`), `.popover`, `.cat-pills`/`.cat-pill`, `.table`, `.stats-grid`/`.stat`, `.tag`, `.badge`, `.modal-overlay`/`.modal`, `.log-box`, `.floating`, `.card`.

New pages start from `docs/page-template.html` and must be added to the `<nav>` in every page.

## GPX conventions
- Originals live in the immutable store `TracksGps/store/{uid}.gpx`. Never rename, move or rewrite them; name/activity/zone/notes/url live only in the DB and are applied on the fly when downloading (`applyGpxMetadata()` in `domain/gpx-export.js`).
- A browsable `Actividad/Sierra/Nombre.gpx` copy is produced on demand: Admin → Gestión de Tracks → «Exportar en carpetas» (`scripts/export-folders.js`, refuses destinations inside `TracksGps`) or the ZIP «tree» layout.
- `scripts/migrate-store.js [--dry-run] [--revert <manifest>]` moves legacy folder files into the store and writes a revert manifest to `data/migrations/`.
- Files with `YYYY-MM-DD` filename prefix get that date if no `<time>` tag is present.
- Files with only `<wpt>` (no `<trkpt>`) are skipped by the import scripts.
- `<wpt>` waypoints are parsed (lat/lon/ele/name/sym/desc) and stored as `waypoints_json`.
