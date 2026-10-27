# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Import new files from TracksGps/_TEMP_/ into the store (classifies, geocodes, skips duplicates)
node scripts/import-from-temp.js [--force]

# Tests: pure domain logic + repository and store contract tests (Postgres; S3 skipped if unreachable)
# (Postgres tests use a separate gpxlibrary_test database and are skipped if it is unreachable)
npm test

# Local PostgreSQL + PostGIS + S3 (Garage), all via Docker Desktop; credentials in .env
docker compose up -d

# Local S3 store (Garage): first-time setup (idempotent)
node scripts/storage-setup.js

# Sync S3 GPX files to a local mirror folder (LOCAL_SYNC_DIR in .env)
node scripts/sync-local.js [--dir <path>] [--clean]

# Backup: export Postgres → gzipped SQLite; restore: import SQLite → Postgres
node scripts/db-copy.js --to sqlite [--sqlite data/otra.db] [--replace]
node scripts/db-copy.js --to postgres [--replace]

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

### Data access — `repo/` (PostgreSQL only)
`config.js` loads `.env` (no dependency) and exposes `DATABASE_URL`, `S3` config and `LOCAL_SYNC_DIR`. `repo/index.js#createRepo()` returns `repo/postgres.js` (requires `DATABASE_URL`). Async API: `listTracks`, `getTrack`, `getPoints`, `catalogTracks`, `updateTrack`, `bulkUpdate`, `moveTrack`, `deleteTrack`, `tags`, `geo`, `recentIds`, config CRUD… Column lists in `repo/columns.js`; names sorted with `COLLATE "C"`, dates with `NULLS LAST`, every ordering ends with `id`. Postgres schema: `repo/pg/NNN_*.sql`, applied by `repo/pg-migrate.js` at startup; points are a PostGIS `LineString` (`geom`/`geom_clean`) plus `ele`/`ele_clean` arrays. Scripts and admin maintenance use `repo/sql.js#openSql()`: Postgres-only async `all/get/run/exec/tx` with `?` placeholders auto-converted to `$N`, `db.NOW`/`db.NOW_TEXT` for timestamps, `db.BIN` after text ORDER BY terms, `CAST(COUNT(*) AS INTEGER)` for counts, `getPoints`/`setPoints` for GPS points. Server gets one via `sqlDb()`. Backups: `db-copy.js --to sqlite` dumps Postgres → gzipped SQLite (for archiving), `--to postgres` restores. Only npm dependency: `pg`.

### GPX store — `blob/` (always S3)
`blob/s3.js` — minimal S3 client, AWS SigV4 on `node:http`, path-style, no dependencies; works with Garage, R2, AWS (`S3_*` vars). API: `put` (never overwrites), `get` (null if missing), `exists`, `del`, `list`, `ping`. Keys are flat: `{uid}.gpx`. `blob/index.js` exposes `getBlob()` (shared instance) and `createBlob({ s3 })` (for tests/scripts). Code must go through `scripts/store.js` (`putFile`, `readTrackFile`, `deleteTrackFile`, `gpxText`) — never `path.join(ROOT, track.file)` directly. Local Garage: `docker compose` service `storage` (`dxflrs/garage`, config `db/garage.toml`, secrets in `.env`); `node scripts/storage-setup.js` configures the layout and buckets (idempotent). Local mirror: `scripts/sync-local.js [--dir <path>] [--clean]` downloads S3 files missing locally; auto-triggered as a background job after each import. Status via `GET /api/admin/storage`. `blob/blob.test.js` (S3, skipped if unreachable). DB backups do not include the GPX files.

### Docker deployment
`Dockerfile` + compose service `app` (`docker compose up -d --build`, port `APP_PORT` default 8081) + `worker` service (same image, runs `node worker.js`). Compose sets `DATABASE_HOST=db:5432` (`config.js` rewrites the host of `DATABASE_URL`), `S3_ENDPOINT=http://storage:3900` and `LOCK_BACKENDS=1`. Everything else the app writes lives in the `appdata` volume at `/app/data`; `osm-settings.json`, `ibp.key` and `TracksGps/_TEMP_` are symlinks into it. `HOST` sets the listen address (default loopback). `scripts/docker.js` locates the docker CLI.

Static files are an allow-list (`isPublicFile()` in `server.js`): root `*.html`/`*.css`, the browser scripts in `PUBLIC_JS` and `assets/`. A new front-end script must be added to `PUBLIC_JS`. No CORS headers; non-GET requests with a foreign `Origin` get 403.

Node.js HTTP server (`server.js`); PostgreSQL via `repo/postgres.js`. Requires Node v22+ for `node:sqlite` (used only in `db-copy.js` backup/restore).

### DB tables
Key tables: `tracks`, `raw_points`, `clean_points`, `config_activities`, `config_sierras`, `jobs`, `job_logs`.

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
- `GET /api/admin/version` — `{version, name, db}` (`db` is always `'postgres'`)
- `POST /api/db/import-temp` (SSE) — enqueues `import-from-temp` job, streams output
- `POST /api/db/enrich-road-types?ids=1,2,3` (SSE) — enqueues `enrich-road-types` job
- `POST /api/db/clean?ids=…` (SSE) — enqueues `clean-tracks` job
- `POST /api/import/wikiloc` (SSE) — body `{ url }`, enqueues `wikiloc-import`; requires `wikiloc_token` in `osm-settings.json`
- `GET /api/jobs` — job list (`?limit=N`, includes `worker: 'embedded'|'external'`)
- `GET /api/jobs/:id` — single job
- `GET /api/jobs/:id/stream` (SSE) — live or historical output of a job
- `POST /api/jobs/:id/cancel|retry` — cancel (sets `cancelling`) or retry (new job id)
- `POST /api/db/sync-local` (SSE) — enqueues `sync-local` job (mirrors S3 → `LOCAL_SYNC_DIR`); auto-triggered after each successful import
- `GET /api/config/settings` — returns `osm-settings.json` (token values masked)
- `PATCH /api/config/settings` — updates allowed keys (`wikiloc_token`, `local_sync_dir`) in `osm-settings.json`
- `/api/admin/…` — stats, backup, restore, vacuum, integrity

All long-running operations go through the job queue (`queue/`). `apiRunScript(res, scriptPath, args)` enqueues the job and relays its SSE output from the DB, so closing the browser does not stop the work. The embedded worker (`EMBEDDED_WORKER !== '0'`) starts with the server; in Docker, `EMBEDDED_WORKER=0` on `app` and the standalone `worker` service runs `node worker.js`.

### Pages
- `/` → `index.html` + `visor.js` + `visor.css` — Leaflet map, track list, filters, elevation profile
- `/track?id=N` → `track.html` + `track.css` — detail view with tabs (Resumen, Puntos de paso, Tipos de camino, Subidas, Tiempo hoy)
- `/editor` → `editor.html` — CRUD list, import from `_TEMP_`, tag editing
- `/admin` → `admin.html` — tabs: Base de datos (backup/restore/vacuum, stats), Gestión de Tracks, Actividades, Sierras / Zonas, Provincias & CCAA, Parámetros (climb thresholds + Wikiloc token), **Trabajos** (job list/view/cancel/retry), Logs, Acerca de. Tabs are deep-linkable via `#tab` (e.g. `/admin#jobs`).
- `/perfil` → `perfil.html` + `perfil.js` — user profile, tabs Mi perfil (avatar in S3 `avatars/{uid}-{ts}.ext`, name, bio, password), Mis rutas (visibility toggle), Mis listas (`user_lists`/`user_list_tracks`), Planeadas (`tracks.planned`), Estadísticas. APIs under `/api/profile/*` and `/api/lists*`.
- `/trazar` → `trazar.html` — route drawing/editing (draw, drag/insert/delete vertices, trim, waypoints, join other tracks, undo). `?join=1,2` opens several tracks joined in order (used by Comparar → Unir). Optional trail snapping via BRouter (brouter.de) and elevation via Open-Meteo. Saving builds a GPX client-side, uploads it with `/api/import/upload`, runs `/api/db/import-temp`, then PATCHes activity/notes. Editing an existing track always saves a new copy — source GPX files are never rewritten.

### Visor (`visor.js`)
- Loads track data by fetching `GET /api/catalog` asynchronously at startup (async IIFE). No longer depends on the global `catalog-data.js` file.
- Polylines are only added to the map when active or being previewed (hover). When a track is active, other tracks' polylines are suppressed — `previewTrack` is a no-op when `activeIdx !== null`.
- `activateTrack(i, fitMap)` manages the active polyline + highlights the list row (`.track-item.active`).
- Filters live in chips + popovers; `applyFilters()` shows/hides markers and updates the list.
- `geoFilter` — Nominatim place search sets a radius circle filter.
- Owner filters: chip «Mis rutas» is a toggle (`gMineOnly`); chip «Usuarios» is a multi-select popover (`#user-filters`) of catalog owners. «Crear ruta» is the floating `#btn-crear-ruta` (bottom centre of the map, hidden while the elevation profile is open). Activity photos for list cards: `ACT_PHOTOS` map → `assets/activities/*.jpg`.

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

### Job queue — `queue/`
All long-running operations run as jobs in the database so closing the browser doesn't abort them.

- **`queue/index.js`** — `createQueue(db)` returns `{ enqueue, claim, heartbeat, log, complete, fail, release, markCancelled, cancel, retry, get, list, logs, activeCount, dataVersion, recoverStale, prune }`. Claim uses `SELECT … FOR UPDATE SKIP LOCKED` on Postgres (no lock on SQLite). `fail` applies exponential backoff (30 s·2^n) up to `maxAttempts`. `dataVersion()` → epoch ms of last terminal job change, used to invalidate the catalog cache.
- **`queue/worker.js`** — `createWorker({ getQueue, onFinish, isPaused, … })` spawns `scripts/<type>.js`, flushes log lines every 300 ms, sends heartbeats every 5 s, kills child on `cancelling`. Housekeeping every 30 s: `recoverStale(90)` + `prune(30)`.
- **`queue/jobs.js`** — `JOBS` map of type → `{ label, maxAttempts? }` for all scriptable operations; `scriptOf(type)`, `levelOf(text)`, `summarize(lines, code)`.
- **`worker.js`** (root) — standalone worker for Docker (`EMBEDDED_WORKER=0`); migrates Postgres schema, opens the same `openSql()` instance as the server, same `onFinish` hooks. Handled by the `worker` service in `docker-compose.yml`.

New job types go in `queue/jobs.js` (add to `JOBS`) and must have a matching `scripts/<type>.js` that reads `process.argv` for `--ids`/`--all`/`--url` etc. (same CLI interface already used by the existing scripts). Tests: `queue/queue.test.js`.

## Design system — `shared.css` (MANDATORY for every page)

Every page must `<link rel="stylesheet" href="/shared.css">` followed by `<script src="/theme.js"></script>` (applies light/dark theme before paint and adds the nav toggle). Dark mode works by redefining the tokens, so never hard-code neutral colors — for surfaces that use the ink color as a background (primary buttons, active chips/tabs, toasts) use `--solid` / `--on-solid`, and for tinted backgrounds use `color-mix(in srgb, <hue> N%, transparent)` instead of light pastel hex. Use CSS variables (`--ink`, `--ink-2`, `--muted`, `--soft`, `--line`, `--surface`, `--bg`, `--accent`, `--accent-soft`, `--success`, `--warn`, `--danger`, `--radius`, `--shadow`, etc.).

Key component classes: `.btn` (+ modifiers), `.input`/`.select`, `.chip` (+ `.active`, `.open`), `.popover`, `.cat-pills`/`.cat-pill`, `.table`, `.stats-grid`/`.stat`, `.tag`, `.badge`, `.modal-overlay`/`.modal`, `.log-box`, `.floating`, `.card`.

New pages start from `docs/page-template.html` and must be added to the `<nav>` in every page. Mark the current page's nav link with `class="active"` (the nav is light: `--nav-bg`). `theme.js` appends the theme toggle and then the user icon (`#nav-perfil`, avatar or initial, name on hover via `data-name`) at the right end; it creates the icon if the page lacks it and exposes `window.gpxSetNavUser(me)` to refresh it.

## GPX conventions
- Originals live in the immutable store (key `{uid}.gpx` in `blob/`: local `TracksGps/store/` or S3). Never rename, move or rewrite them; name/activity/zone/notes/url live only in the DB and are applied on the fly when downloading (`applyGpxMetadata()` in `domain/gpx-export.js`).
- A browsable `Actividad/Sierra/Nombre.gpx` copy is produced on demand: Admin → Gestión de Tracks → «Exportar en carpetas» (`scripts/export-folders.js`, refuses destinations inside `TracksGps`) or the ZIP «tree» layout.
- Files with `YYYY-MM-DD` filename prefix get that date if no `<time>` tag is present.
- Files with only `<wpt>` (no `<trkpt>`) are skipped by the import scripts.
- `<wpt>` waypoints are parsed (lat/lon/ele/name/sym/desc) and stored as `waypoints_json`.
