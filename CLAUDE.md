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

# Phase 3 scale bench: synthetic routes in the separate DB gpxlibrary_bench (never touches gpxlibrary/S3), then measure
# current catalog vs candidate queries (paginated list, ST_AsMVT tiles, trigram search) → data/bench/bench-<date>-<n>rutas.json
node scripts/synth-tracks.js --count 10000 [--reset]
node scripts/bench.js [--db bench|real] [--runs 30]
# /api/search must give what visor.js computes from /api/catalog (random boxes and filters, throwaway account)
node scripts/search-check.js [--base http://localhost:8081] [--runs 300]

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

### Track photos — S3 `photos/` + `track_photos`
Photos, activity images and activity icons live in the S3 store under `photos/<rel>` (`photoPut`/`photoGet`/`photoDel` in `server.js`: `rel` is the filename, `activities/<f>` or `act-icons/<f>`). `photoGet` falls back to the old disk copy in `config.PHOTOS_DIR` (Docker volume `photodata`); `node scripts/photos-to-s3.js [--delete]` copies that folder to S3 (idempotent). Postgres table `track_photos` (migration `005`) references each file to its track/owner. API: `GET/POST /api/tracks/:id/photos` (upload base64 JSON, owner/admin only, ≤8 MB), `GET /api/photos/:id` (served by track visibility), `DELETE /api/photos/:id`. Track detail shows a photo strip (`#track-photos`).

### Upload Trail wizard — `/subir`
`subir.html` + `subir.js`: a 3-step wizard (chip "Upload Trail" added to the nav by `theme.js` for logged-in users). Step 1 import a local GPX (parsed client-side with DOMParser) or draw (→ `/trazar`); step 2 preview (Leaflet mini-map, distance, waypoints); step 3 upload+import on the server (reuses `/api/import/upload` + `/api/db/import-temp`, capturing `IMPORTED_IDS:`), then edit name/description/activity/sierra (precalculated, datalists from `/api/config/provinces`), privacy (via `/api/profile/tracks/:id/visibility`) and photos, then PATCH and redirect to `/track?id=`. `/subir?edit=ID` is the single edit form for an existing route (the «Editar» button of `/track` links there; the old modal was removed): it opens step 3 directly (owner/admin only), also shows province, CCAA, source URL and tags (`.edit-only`), and saves `planned` both ways.

### Lists, sharing and achievements
Lists (`user_lists`, `user_list_tracks`) have `visibility` ('private'|'public') and per-user shares in `user_list_shares (list_id, user_id, can_edit)` (migration `006`). `listAccess(listId, userId, isAdmin)` in `server.js` returns the role `owner|editor|viewer|null`; viewers can read `/api/lists/:id/tracks` (returns `{role, tracks}`), editors can add/remove tracks, only owners rename/delete/share (`/api/lists/:id/shares`). `/api/lists/shared` lists what others shared with me or made public. The list endpoints sit before the role gate, so they must not use the `isAdmin` const (TDZ) — use `req.user.role === 'admin'`.
Achievements: `GET /api/profile/achievements` computes badge families × 5 tiers and an XP level on the fly from the user's non-planned tracks, photos and lists (no table); shown in Perfil → Logros. Tracks with impossible data (`anomaly` limits in the gamification config: mean speed, ascent per km, km and ascent per day) don't count and come back in `excludedRoutes`. Direct-link list page: `/lista?id=N` (`lista.html` + `lista.js`, `GET /api/lists/:id` for the header); shared lists never expose other people's private routes. Tracks marked `planned` can be set from /trazar and the Upload Trail wizard via `PATCH /api/profile/tracks/:id/planned`.

### GPX store — `blob/` (always S3)
`blob/s3.js` — minimal S3 client, AWS SigV4 on `node:http`, path-style, no dependencies; works with Garage, R2, AWS (`S3_*` vars). API: `put` (never overwrites), `get` (null if missing), `exists`, `del`, `list`, `ping`. Keys are flat: `{uid}.gpx`. `blob/index.js` exposes `getBlob()` (shared instance) and `createBlob({ s3 })` (for tests/scripts). Code must go through `scripts/store.js` (`putFile`, `readTrackFile`, `deleteTrackFile`, `gpxText`) — never `path.join(ROOT, track.file)` directly. Local Garage: `docker compose` service `storage` (`dxflrs/garage`, config `db/garage.toml`, secrets in `.env`); `node scripts/storage-setup.js` configures the layout and buckets (idempotent). Local mirror: `scripts/sync-local.js [--dir <path>] [--clean]` downloads S3 files missing locally; auto-triggered as a background job after each import. Status via `GET /api/admin/storage`. `blob/blob.test.js` (S3, skipped if unreachable). DB backups do not include the GPX files.

### Docker deployment
`Dockerfile` + compose service `app` (`docker compose up -d --build`, port `APP_PORT` default 8081) + `worker` service (same image, runs `node worker.js`). Compose sets `DATABASE_HOST=db:5432` (`config.js` rewrites the host of `DATABASE_URL`), `S3_ENDPOINT=http://storage:3900` and `LOCK_BACKENDS=1`. Everything else the app writes lives in the `appdata` volume at `/app/data`; `osm-settings.json`, `ibp.key` and `TracksGps/_TEMP_` are symlinks into it. `HOST` sets the listen address (default loopback). `scripts/docker.js` locates the docker CLI.

Roles: `admin` can use everything. Any other user only gets what `userMayAccess()` in `server.js` allow-lists (`USER_PAGES`, `USER_API`): viewer/search, `/track`, `/compare`, `/trazar`, `/perfil` and their APIs; `/admin` and `/editor` (catalog) redirect to `/`, other APIs return 403. Non-admins see public tracks plus their own private ones, and may PATCH/DELETE only their own tracks; `/api/db/import-temp` requires `files` (no `src`/`force`). Imports pass `--owner <userId>` to `import-from-temp.js`, which sets `owner_id` only on newly created tracks. Login is case-insensitive. `theme.js` hides only the Admin nav link for non-admins (the catalog is open to all). The catalog (`/editor`) is a `USER_PAGE`: non-admins fetch `/api/tracks?mine=1` (own tracks only) and the page hides `.admin-only` controls and the `.col-owner` column via `body:not(.is-admin)`; admins see every track plus the Dueño column, owner filter and «Cambiar dueño». Non-admin bulk-update/bulk-delete/move are restricted to owned tracks server-side (`ownedOnly`/`ownsTrack`). Track detail has an «Añadir a lista» dropdown (any logged-in user) backed by `/api/lists`. Jobs carry `payload.user` (set in `apiRunScript`) shown in Admin → Trabajos, which also has `POST /api/jobs/prune {days}`. Backups: `db-copy.js` uses `config.DATABASE_URL` (honors `DATABASE_HOST`) so the dump works in Docker. Every request re-reads the account's `role`/`active` (`liveUser()`, 15 s cache cleared on user changes), so deactivating or demoting a user takes effect at once although the JWT still carries the old role. User management: Admin → Usuarios (`GET/POST /api/admin/users`, `PATCH|DELETE /api/admin/users/:id`, delete takes `?reassign_to=`; you can't deactivate/demote/delete yourself or the last admin) and `POST /api/admin/tracks/owner` (`{ids|orphans, owner_id, visibility?}`), also used by the catalog's «Cambiar dueño».

### Accounts and privacy (pre-launch, migration `015`)
- **Registration** `/registro` → `POST /api/auth/register` (open unless Admin → Usuarios closes it: `app_settings` key `auth`, `GET /api/auth/options`); requires accepting `/privacidad` (`users.terms_accepted_at`).
- **Password reset** `/restablecer`: `POST /api/auth/forgot {email}` (always 200) stores the SHA-256 of a 1-hour single-use token in `password_resets` and emails the link with `mail/smtp.js` (dependency-free SMTP: 465 TLS or STARTTLS; `SMTP_*` and `PUBLIC_URL` in `.env`). Without SMTP the link goes to Admin → Logs. `GET|POST /api/auth/reset`. Admin → Usuarios shows SMTP status and sends a test (`/api/admin/auth-settings`, `/api/admin/smtp-test`).
- **Attempt limits** (in memory, per process): `tooMany(key, max, windowMs)`; login 5 per account+IP / 30 per IP in 15 min (429), registration and reset requests per IP/email. `TRUST_PROXY=1` takes the IP from `X-Forwarded-For`.
- **Privacy zones**: `users.privacy_radius` (m, Perfil → Mi perfil). Others never see points near the start/end of that user's routes: `domain/privacy.js` (`privacyZones` moves and enlarges the circle with the track id as seed) applied by `applyPrivacy()` in the catalog (cached per viewer), `GET /api/tracks/:id` (also waypoints, bounds; sets `privacy_hidden`), GPX download and export (a trimmed GPX is generated instead of the original). The owner and admins see everything. Export endpoints skip tracks the viewer may not see.
- **Own data**: `GET /api/profile/export` (ZIP: account, routes JSON + original GPX, lists, photos, avatar) and `DELETE /api/profile {password}` (deletes routes, files, photos, lists; not the last admin). App logs older than 30 days are deleted (`pruneLogs` in `scripts/applog.js`).

Derived data (migration `016`, `domain/derive.js`, job `track-derive`): `tracks.geom_view` is what other people see (clean-or-raw geometry minus the owner's privacy zones, track id as seed); from it `geom_s1` (15 m), `geom_s2` (150 m), `start_point`, plus `search_text` (accent-free) and `derived_at`. Tolerances live in `DERIVE_TOLERANCES` (real metres; scaled by latitude when simplifying in 3857). `scripts/track-derive.js [--ids|--all|--owner|--missing]` is enqueued after imports, after `clean-tracks` and when a user changes `privacy_radius`; `search_text` is refreshed in the track PATCH and bulk-update.

Every response goes through `enableCompression()` (`http/compress.js`): text bodies ≥ 1 KB with status 200 are sent with brotli/gzip (the status line is held until `end`; `res.write` streams such as SSE pass untouched; bodies with an ETag are cached compressed).

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
- `GET /api/search` — visor search (phase 3, `repo/search.js`): `bbox=w,s,e,n`, filters (`act`, `sierra`, `tag` repeatable; `dmin/dmax`, `emin/emax`, `gmin/gmax` grade, `year`, `q`, `near=lat,lon,km`, `rtype`, `mine`, `user`, `ids`), `sort`, `page`, `size`, `line=s1|s2`, `starts=1`. Returns one page with start point, bounds and simplified hover line, the box totals (counted up to `COUNT_CAP` = 1000, then `totalCapped` and no km/ascent) and the cascading pill counts (not limited to the box, cached per filters + data version). Same semantics as visor.js; `node scripts/search-check.js` compares both against a running server. Others' routes are matched on `geom_s1`; indexes for the sort orders in migration `018`
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

### Visor nuevo (`/visor2`, en pruebas)
`visor2.html` + `visor2.js`: the visor fed by the server instead of `/api/catalog`. Moving the map or changing filters, sort or page asks `/api/search` for one page (250 ms debounce, `AbortController`, `line=s2` below zoom 11) and gets the pill counts (`facets`) and, when the map mode needs them, the start points (`starts=1`). Years, owners, slider maxima and the initial box (`core`, 5th–95th percentile) come from `/api/search?meta=1`. A route's line appears only on hover (`item.line`, or `GET /api/tracks/:id/preview` for routes that only came as a start point); the elevation profile uses `GET /api/tracks/:id`. Per-route colours are stored as `id:N` (the old visor keyed them by file). `visor.js` stays untouched until `/visor2` replaces it.

### Visor (`visor.js`)
- Loads track data by fetching `GET /api/catalog` asynchronously at startup (async IIFE). No longer depends on the global `catalog-data.js` file.
- Polylines are only added to the map when active or being previewed (hover). When a track is active, other tracks' polylines are suppressed — `previewTrack` is a no-op when `activeIdx !== null`.
- `activateTrack(i, fitMap)` manages the active polyline + highlights the list row (`.track-item.active`).
- Filters live in chips + popovers; `applyFilters()` shows/hides markers and updates the list.
- `geoFilter` — Nominatim place search sets a radius circle filter.
- Map markers follow the user preference `users.prefs.map_mode` (migration `017`, Perfil → Mi perfil → Visor, `PATCH /api/profile/me {map_mode}`, returned by `/api/auth/me`): `page` (default) only the routes of the list page — or all of them when the routes in view fit in 3 pages (`PAGE_MODE_ALL_PAGES`), `mixed` those plus a small dot at the start of the other routes in view, `all` every route in view. Lines always appear only on hover (`syncMapMode()`).
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

New pages start from `docs/page-template.html` and must be added to the `<nav>` in every page.

Icons: `icons.js` is a monochrome line-icon library (`currentColor`): `window.GPX_ICONS` (key → `{label, group, svg}`), `gpxIcon(key, {size, cls})` (unknown key → the text itself, so old emoji still render) and `gpxIconPicker(anchor, current, onPick)`. Activity icons (`config_activities.icon`) and badge icons (gamification `families[].icon`) store these keys. Each activity also has a default `image` (stock `/assets/activities/*.jpg` or uploaded via `POST/DELETE /api/config/activities/:id/image`, stored in `PHOTOS_DIR/activities`, served at `/api/activity-images/:file`), used by the visor when a route has no cover photo. Mark the current page's nav link with `class="active"` (the nav is light: `--nav-bg`). `theme.js` appends the theme toggle and then the user icon (`#nav-perfil`, avatar or initial, name on hover via `data-name`) at the right end; it creates the icon if the page lacks it and exposes `window.gpxSetNavUser(me)` to refresh it.

## GPX conventions
- Originals live in the immutable store (key `{uid}.gpx` in `blob/`: local `TracksGps/store/` or S3). Never rename, move or rewrite them; name/activity/zone/notes/url live only in the DB and are applied on the fly when downloading (`applyGpxMetadata()` in `domain/gpx-export.js`).
- A browsable `Actividad/Sierra/Nombre.gpx` copy is produced on demand: Admin → Gestión de Tracks → «Exportar en carpetas» (`scripts/export-folders.js`, refuses destinations inside `TracksGps`) or the ZIP «tree» layout.
- Files with `YYYY-MM-DD` filename prefix get that date if no `<time>` tag is present.
- Files with only `<wpt>` (no `<trkpt>`) are skipped by the import scripts.
- `<wpt>` waypoints are parsed (lat/lon/ele/name/sym/desc) and stored as `waypoints_json`.
