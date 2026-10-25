# CODEMAP — Referencia técnica de GPX Library

Guía de navegación del código. Actualizar cuando cambien las estructuras clave.

---

## Árbol de archivos

```
gpxlibrary/
├── index.html          Visor principal (Leaflet, vanilla JS)
├── editor.html         Editor de tracks y herramientas de gestión
├── track.html          Página de detalle de un track
├── admin.html          Admin: motor de BD, stats, backups, mantenimiento, actividades, sierras, parámetros, logs
├── compare.html        Comparador de rutas (→ Unir abre /trazar?join=…)
├── trazar.html         Dibujar / editar una copia de una ruta
├── shared.css          Estilos comunes: nav, .page-header, .hbtn-nav
├── server.js           Servidor HTTP + toda la API REST
├── config.js           Lee .env: DB_DRIVER (sqlite|postgres), DATABASE_URL, SQLITE_PATH
├── docker-compose.yml  PostgreSQL 17 + PostGIS 3.5 (db) y Garage S3 (storage) locales
├── .env                NO en git — motor activo y contraseña de PostgreSQL
├── catalog-data.js     AUTO-GENERADO — const CATALOG = [...]
├── ibp.key             API key de IBP Index (no en git)
├── data/               NO en git (.gitignore)
│   ├── tracks.db       SQLite (cuando DB_DRIVER=sqlite)
│   └── backups/        Copias: siempre SQLite comprimido (tracks-YYYY-MM-DDTHH-MM-SS.db.gz), restaurables en ambos motores
│
├── repo/               Acceso a datos con la misma API en los dos motores
│   ├── index.js / sqlite.js / postgres.js   Repositorio usado por server.js (getRepo)
│   ├── sql.js          openSql(): SQL async neutro para scripts y mantenimiento
│   ├── columns.js      Listas de columnas compartidas
│   ├── pg-migrate.js + pg/NNN_*.sql   Esquema PostgreSQL
│   └── repo.test.js    Tests de contrato contra los dos motores
│
├── blob/               Almacén de los GPX originales (STORAGE_DRIVER=local|s3)
│   ├── index.js        createBlob() / getBlob()
│   ├── local.js        Carpeta TracksGps/store
│   ├── s3.js           Cliente S3 mínimo (SigV4, sin dependencias): Garage, R2, AWS
│   └── blob.test.js    Tests de contrato contra los dos almacenes
│
├── scripts/
│   ├── db.js                   SQLite: openDb(), schema y migraciones (los scripts usan repo/sql.js)
│   ├── db-copy.js              Copia entre motores (--to postgres|sqlite) y --verify
│   ├── import-from-temp.js     Pipeline completo: geocodifica + clasifica + guarda en store/ + importa
│   ├── store.js                Almacén inmutable: clave {uid}.gpx, putFile/readTrackFile/deleteTrackFile, sha256
│   ├── blob-copy.js            Copia GPX local ↔ S3 comprobando sha256 (--verify)
│   ├── storage-setup.js        Configura Garage: secretos en .env, buckets y clave
│   ├── docker.js               Localiza docker (instalación global o por usuario)
│   ├── migrate-store.js        Migra carpetas antiguas al almacén (--dry-run, --revert)
│   ├── export-folders.js       Copia Actividad/Sierra/Nombre.gpx en una carpeta elegida
│   ├── export-catalog.js       BD → catalog-data.js (con simplificación de puntos)
│   ├── build-catalog.js        GPX → catalog-data.js (sin BD, modo legacy)
│   ├── clean-tracks.js         Elimina ruido GPS de raw_points → clean_points
│   ├── enrich-road-types.js    Enriquece con tipo de camino/superficie (OSM Overpass)
│   ├── enrich-tracks.js        Provincia / CCAA / sierra / actividad (Nominatim)
│   ├── osm-precache.js         Descarga OSM por zonas; osm-strategy-*.js y osm-shared.js
│   ├── backfill-catalog-pts.js Rellena catalog_pts (polilínea del catálogo)
│   ├── calc-ibp.js             Calcula IBP Index vía API ibpindex.com
│   └── extract-urls.js         Extrae URLs de los metadatos GPX
│
├── domain/             Lógica pura (sin BD ni disco): parseo GPX, métricas, clasificación,
│                       IBP, simplificación/limpieza y exportación GPX + tests (npm test)
│
└── TracksGps/          NO en git (.gitignore)
    ├── store/          Originales inmutables: {uid}.gpx
    └── _TEMP_/         Zona de entrada; se vacía al importar
```

---

## Base de datos

Esquema descrito en SQLite; en PostgreSQL es el mismo `tracks` salvo que los puntos van en `geom`/`ele` y `geom_clean`/`ele_clean` (PostGIS `LineString` + arrays) en lugar de `raw_points`/`clean_points`.

### `tracks` — tabla principal

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | INTEGER PK | Auto-incremental |
| `name` | TEXT | Nombre del track |
| `file` | TEXT UNIQUE | Ruta relativa al .gpx desde la raíz |
| `activity` | TEXT | Tipo de actividad (Mtb, Senderismo, …) |
| `zone` | TEXT | Segunda carpeta bajo TracksGps/ |
| `sierra` | TEXT | Zona montañosa detectada |
| `province` | TEXT | Provincia (Nominatim) |
| `ccaa` | TEXT | Comunidad Autónoma (Nominatim) |
| `date` | TEXT | YYYY-MM-DD |
| `distance` | REAL | km |
| `elevation_gain/loss` | REAL | metros acumulados |
| `min/max_elevation` | REAL | metros |
| `sw/ne_lat/lon` | REAL | Bounding box |
| `center_lat/lon` | REAL | Centro geográfico |
| `raw_count` | INTEGER | Puntos en raw_points |
| `clean_count` | INTEGER | Puntos en clean_points |
| `cleaned` | INTEGER | 0/1 — si se usó clean_points |
| `color` | TEXT | Color per-track (override de actividad) |
| `notes` | TEXT | Notas libres |
| `url` | TEXT | URL fuente original |
| `tags` | TEXT | JSON array de etiquetas |
| `road_types` | TEXT | JSON {tipo: km} — datos OSM |
| `surface_types` | TEXT | JSON {superficie: km} — datos OSM |
| `moving_time` | INTEGER | Segundos en marcha |
| `stopped_time` | INTEGER | Segundos parado |
| `ibp_bicycle` | REAL | IBP modalidad ciclismo |
| `ibp_hiking` | REAL | IBP modalidad senderismo |
| `ibp_running` | REAL | IBP modalidad running |
| `imported_at` | TEXT | Timestamp de importación |

### `raw_points` / `clean_points`

```
track_id INTEGER, seq INTEGER, lat REAL, lon REAL, ele REAL
PRIMARY KEY (track_id, seq)
```

### `config_activities`

```
id, name, color, keywords, sort_order, active
```
Los `keywords` se usan en `import-from-temp.js` para auto-clasificar. El `color` se sincroniza con `localStorage['gpx-act-colors']` al guardar desde Admin → Actividades.

### `config_sierras`

```
id, name, sw_lat, sw_lon, ne_lat, ne_lon, active
```
Bounding boxes de respaldo cuando Nominatim no devuelve nombre de sierra.

---

## Flujo de datos principal

### Importación (_TEMP_ → BD → Catálogo)

```
_TEMP_/*.gpx
  ↓ import-from-temp.js
  1. parseGpx()          — lee puntos, métricas básicas
  2. fetchNominatim()    — province, ccaa, sierra (1 req/seg)
  3. inferActivity()     — keywords + dist/gain heurístico
  4. moveFile()          — TracksGps/<Actividad>/<Sierra>/
  5. importTrack()       — INSERT/UPDATE tracks + raw_points
  ↓ server: triggerCatalogRebuild()
  6. export-catalog.js   — BD → catalog-data.js
     · simplify(pts, 150) — muestreo uniforme
     · const CATALOG = [...] expuesto como global
```

### Visor (index.html)

```
<script src="catalog-data.js">   ← CATALOG global cargado síncronamente
  ↓
buildFilters()    — construye pills, sliders, selects desde CATALOG
addTrack(tr)      — para cada track:
                    · L.polyline → canvas renderer
                    · L.marker   → icono SVG por actividad
                    · oculto por defecto hasta que applyFilters() lo muestre
applyFilters()    — evalúa cada track contra los filtros activos
activateTrack(i)  — selecciona track: highlights, bounds, popup, perfil elevación
showProfile()     — SVG de perfil en #profile (175px, bajo el mapa)
```

### API REST (server.js)

Servidor HTTP vanilla en Node.js. Todas las rutas en una única función `handleRequest`.

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/tracks` | Lista todos los tracks (tabla editor) |
| GET | `/api/tracks/:id` | Track individual con puntos (detalle) |
| PATCH | `/api/tracks/:id` | Edita metadatos (name, activity, notes, …) |
| DELETE | `/api/tracks/:id` | Borra track + fichero GPX |
| POST | `/api/tracks/export-gpx` | Exporta IDs seleccionados como GPX |
| GET | `/api/tracks/:id/export-gpx` | Exporta un track individual |
| GET | `/api/db/temp-files` | Lista GPX en _TEMP_ |
| GET | `/api/admin/stats` | Stats BD completas: tracks, raw/clean points, por actividad, tamaño, WAL, backups |
| POST | `/api/admin/backup` | Crea backup en `data/backups/` (SQLite: `VACUUM INTO`; PostgreSQL: volcado con `db-copy.js`) |
| GET | `/api/admin/backups` | Lista backups disponibles |
| POST | `/api/admin/restore/:filename` | Restaura un backup (SQLite: sustituye el fichero; PostgreSQL: lo carga con `db-copy.js`) |
| DELETE | `/api/admin/backups/:filename` | Elimina un backup |
| POST | `/api/admin/vacuum` | `VACUUM` (SQLite) / `VACUUM (ANALYZE)` (PostgreSQL) |
| GET | `/api/admin/integrity` | `PRAGMA integrity_check` (SQLite) / geometrías y recuentos (PostgreSQL) |
| GET | `/api/admin/db-engine` | Estado de los dos motores |
| GET | `/api/admin/storage` | Estado de los dos almacenes de GPX |
| POST | `/api/admin/storage/switch` | Cambia de almacén con copia y verificación (SSE) |
| POST | `/api/admin/db-engine/switch` | Cambia de motor con copia y verificación (SSE) |
| POST | `/api/db/import-temp` | Lanza import-from-temp.js (SSE) |
| POST | `/api/db/export` | Lanza export-catalog.js (SSE, legado, solo SQLite) |
| POST | `/api/db/calc-ibp` | Lanza calc-ibp.js (SSE) |
| POST | `/api/db/clean` | Lanza clean-tracks.js (SSE) |
| POST | `/api/db/enrich` | Lanza enrich-tracks.js (SSE) |
| POST | `/api/db/enrich-road-types` | Lanza enrich-road-types.js (SSE) |
| GET/POST | `/api/config/ibp-key` | Lee/guarda API key IBP |
| GET | `/api/config/activities` | Lista config_activities |
| POST | `/api/config/activities` | Crea actividad |
| PATCH | `/api/config/activities/:id` | Actualiza actividad |
| DELETE | `/api/config/activities/:id` | Elimina actividad |

#### SSE (Server-Sent Events)

`apiRunScript(res, scriptPath, args)` envuelve un `child_process.spawn`:
- Cada línea de stdout → `data: {"type":"log","text":"..."}\n\n`
- `stderr` → `data: {"type":"error","text":"..."}\n\n`
- Al cerrar → `data: {"type":"done","code":N}\n\n`

Los clientes leen el stream con `fetch + ReadableStream` y lo muestran en el log del modal.

---

## Sincronización de colores/iconos entre páginas

`localStorage` es compartida entre todas las páginas del mismo origen (`localhost:8080`).

```
admin.html   ──save──►  DB (config_activities.color)
                    └──► localStorage['gpx-act-colors'][name] = color
                    └──► localStorage['gpx-act-icons'][name]  = dataUrl

index.html   ──load──►  localStorage['gpx-act-colors']  (al arrancar)
             ◄─storage event─  (cuando Admin guarda)
                    └── setActivityColor(act, color, false)  → re-colorea layers + markers
                    └── actIconsCustom actualizado           → re-genera iconos de markers
```

---

## Colores y iconos de actividad

### En `index.html`

```javascript
const ACT_COLORS = { 'Mtb': '#7c3aed', ... }     // defaults hardcoded
actColorsCustom = JSON.parse(localStorage['gpx-act-colors'])  // overrides de usuario

function actColor(act) {
  return actColorsCustom[act] || ACT_COLORS[act] || PALETTE[idx++];
}

function setActivityColor(act, color, save) {
  // actualiza: polylines, markers, pills, detail header
  // save=true → persiste en localStorage
}
```

### En `admin.html` (Actividades)

`getActIcons() / setActIcon(name, dataUrl)` — lee/escribe `localStorage['gpx-act-icons']`.  
Al guardar una actividad, también escribe `localStorage['gpx-act-colors']`.

---

## IBP Index

**Script**: `scripts/calc-ibp.js`  
**API**: `POST https://www.ibpindex.com/api/` — multipart/form-data con el GPX  
**Respuesta**: `{ bicycle: { ibp: "120", ... }, hiking: { ibp: "85", ... }, running: { ibp: "..." } }`

Modalidad por actividad:
- Ciclismo de carretera, Mtb, Gravel, Bikepacking → `ibp_bicycle`
- Trail Running, Running → `ibp_running`  
- Resto (Senderismo, Montañismo, Ferratas…) → `ibp_hiking`

Niveles (merkabici.es):

| IBP | Nivel |
|-----|-------|
| 0–50 | Muy fácil |
| 51–100 | Fácil |
| 101–150 | Moderada |
| 151–250 | Dura |
| 251–400 | Muy dura |
| >400 | Extrema |

---

## catalog-data.js — formato de cada entrada

```javascript
{
  id, name, file, zone, date,
  activity, sierra, province, ccaa,
  tags,                   // string[]
  distance,               // km
  elevationGain, elevationLoss,
  minElevation, maxElevation,
  bounds,                 // [[swLat,swLon],[neLat,neLon]]
  center,                 // [lat,lon]
  color,                  // null | "#rrggbb"  (override per-track)
  ibp_bicycle, ibp_hiking, ibp_running,   // null | integer
  points,                 // [[lat,lon,ele|null], ...]  ≤150 pts
}
```

`MAX_POINTS = 300` en `export-catalog.js` — simplificación por muestreo uniforme.  
Para exportar GPX completo usar el endpoint `/api/tracks/:id/export-gpx`.

---

## Patrones recurrentes

### Inline editing (editor.html)

```
clic en fila → renderInlineEdit(t)
  · reemplaza <tr> con formulario
  · PUT /api/tracks/:id → rerenderiza fila
```

### Filtros (editor.html y index.html)

Ambas páginas tienen `applyFilters()` que itera todos los items/tracks y muestra/oculta según estado de los controles. En `index.html` usa `layer.addTo(map)` / `layer.remove()` en vez de opacidad para rendimiento con 300+ tracks.

### Exportación GPX (server.js)

```javascript
buildGpx(tracksData)  // construye XML con múltiples <trk>
exportGpxResponse()   // Content-Type: application/gpx+xml + Content-Disposition
```

Un export de múltiples tracks = un solo fichero GPX con varios `<trk>`.

---

## Notas de desarrollo

- `catalog-data.js` es un artefacto heredado; el visor carga `/api/catalog`.
- El visor solo funciona desde HTTP (no `file://`) porque usa fetch/SSE.
- `server.js` no usa Express ni ningún framework — routing manual con `pathname.match()`.
- Única dependencia npm: `pg`, que solo se carga con `DB_DRIVER=postgres`. El resto es stdlib + `node:sqlite` (Node ≥22).
- Los scripts acceden a la BD con `repo/sql.js` (`openSql()`), nunca con `scripts/db.js` directamente, para funcionar en los dos motores.
- `NO_OPEN=1` arranca el servidor sin abrir el navegador.
