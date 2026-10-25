# GPX Library

Biblioteca personal de rutas GPS: visor de mapa, detalle de cada ruta, editor de metadatos, comparador, trazado y edición de rutas, índice de dificultad IBP, tipos de camino de OpenStreetMap y herramientas de mantenimiento. Servidor Node.js sin framework y páginas en HTML + JavaScript con Leaflet.

Funciona con **SQLite** (por defecto, sin instalar nada más) o con **PostgreSQL + PostGIS** (en Docker), con exactamente el mismo comportamiento. Se puede cambiar de motor desde Admin.

## Requisitos

- Node.js ≥ 22.5 (usa `node:sqlite`)
- Opcional, para PostgreSQL: Docker Desktop

## Arranque rápido

```bash
npm install          # solo instala `pg` (el driver de PostgreSQL)
npm start            # servidor en http://localhost:8080
npm run dev          # igual, abriendo el navegador
```

### Con Docker (aplicación + PostgreSQL + Garage)

```bash
node scripts/storage-setup.js        # primera vez: secretos de Garage en .env, buckets y clave
docker compose up -d --build         # → http://localhost:8081 (APP_PORT en .env para cambiarlo)
```

La aplicación del contenedor usa siempre PostgreSQL y S3, así que antes los datos deben estar ahí (Admin → «Motor de base de datos» y «Almacén de GPX», o `db-copy.js --to postgres` y `blob-copy.js --to s3`). Sus copias de seguridad, logs, caché OSM y ajustes (token de Wikiloc, clave IBP) se guardan en el volumen `appdata`; para llevar los ajustes actuales: `docker cp osm-settings.json gpxlibrary-app:/app/data/`.

Al arrancar se abre el navegador; con `NO_OPEN=1` no se abre. Se hace también una copia de seguridad diaria automática si aún no hay una de hoy.

---

## Páginas

| URL | Descripción |
|-----|-------------|
| `/` | **Visor**: mapa con todas las rutas, filtros, perfil de elevación |
| `/track?id=N` | **Detalle**: resumen, puntos de paso, tipos de camino, subidas y tiempo de hoy |
| `/editor` | **Editor**: tabla de rutas, edición de metadatos y etiquetas, importación |
| `/compare` | **Comparar**: varias rutas a la vez; desde aquí se pueden unir |
| `/trazar` | **Trazar**: dibujar una ruta nueva o editar una copia de una existente |
| `/admin` | **Admin**: base de datos, copias, mantenimiento, actividades, sierras, parámetros, logs y «Acerca de» |

---

## Cómo añadir rutas

1. Copia los `.gpx` en `TracksGps/_TEMP_/` (o súbelos desde el Editor), o importa desde **Wikiloc** / **Komoot** con el botón del globo en el visor.
2. Al importar:
   - se descartan los ficheros idénticos a uno ya importado;
   - se geocodifican (Nominatim) y se clasifican por actividad y sierra;
   - las de baja confianza reciben la etiqueta `revisar`.
3. Si es una sola ruta, se abre su detalle. Si son varias, se abre el catálogo filtrado por la última importación.

Los originales se guardan sin tocar en `TracksGps/store/{uid}.gpx`. El nombre, la actividad, la zona, las notas y la URL viven solo en la base de datos y se aplican al descargar. Para tener una copia navegable `Actividad/Sierra/Nombre.gpx`, usa Admin → Gestión de Tracks → «Exportar en carpetas».

---

## Base de datos: SQLite o PostgreSQL

| | SQLite | PostgreSQL + PostGIS |
|---|---|---|
| Dónde | `data/tracks.db` | Contenedor Docker (`docker compose up -d`), `127.0.0.1:5432` |
| Se elige con | `DB_DRIVER=sqlite` en `.env` (por defecto) | `DB_DRIVER=postgres` y `DATABASE_URL` en `.env` (ver `.env.example`) |
| Puntos GPS | Filas en `raw_points` / `clean_points` | Una geometría `LineString` por ruta |

**Cambiar de motor** se hace en Admin → Base de datos → «Motor de base de datos». La aplicación:
1. arranca el contenedor si hace falta;
2. copia los datos al otro motor;
3. comprueba que los dos devuelven lo mismo;
4. cambia de motor sin reiniciar.

Si algo no cuadra, se queda en el motor actual.

**Copias de seguridad** (Admin → Base de datos): siempre son un fichero SQLite comprimido en `data/backups/`, sea cual sea el motor. Cualquier copia se puede restaurar en cualquiera de los dos.

Por línea de comandos:

```bash
node scripts/db-copy.js --to postgres --replace   # SQLite → PostgreSQL
node scripts/db-copy.js --to sqlite --replace     # PostgreSQL → SQLite
node scripts/db-copy.js --verify                  # compara los dos motores
```

### Almacén de los GPX: carpeta local o S3

Los GPX originales se guardan una vez y nunca se modifican. Pueden estar en `TracksGps/store/` (por defecto) o en un almacén compatible con S3: **Garage** en el `docker-compose` para desarrollo, y Cloudflare R2 o AWS S3 en la nube.

```bash
node scripts/storage-setup.js          # primera vez: secretos en .env, arranca Garage, crea buckets y clave
node scripts/blob-copy.js --to s3      # copia los GPX y comprueba cada uno con su huella SHA-256
node scripts/blob-copy.js --verify     # comprueba el almacén activo
```

Se cambia en Admin → Base de datos → «Almacén de GPX» (copia, comprueba y cambia sin reiniciar; el almacén anterior se conserva) o con `STORAGE_DRIVER=local|s3` en `.env`. Las copias de seguridad de la base de datos no incluyen los GPX.

`data/`, `.env` y `osm-settings.json` **no se suben a git** (datos, contraseña de PostgreSQL y token de Wikiloc).

---

## Comandos útiles

Todos los scripts usan el motor configurado en `.env` (o `DB_DRIVER=… node …` para forzar uno).

```bash
npm test                                         # tests de dominio y de los dos motores

node scripts/import-from-temp.js [--force]       # importa TracksGps/_TEMP_
node scripts/calc-ibp.js [--force] [--ids 1,2]   # IBP (requiere clave)
node scripts/clean-tracks.js --stats | --list    # limpieza de ruido GPS
node scripts/clean-tracks.js --track-id 42 --rdp 3
node scripts/clean-tracks.js --reset --track-id 42
node scripts/enrich-road-types.js [--ids 1,2] [--force]   # tipos de camino OSM
node scripts/osm-precache.js                     # descarga OSM por zonas
node scripts/enrich-tracks.js [--ids 1,2] [--dry-run]     # provincia / CCAA / sierra
node scripts/extract-urls.js [--dry-run]         # URL de origen desde el GPX
node scripts/export-folders.js --dest D:/copia [--ids 1,2]
node scripts/migrate-store.js --dry-run          # pasar ficheros antiguos al almacén
```

---

## IBP API Key

1. Regístrate gratis en [ibpindex.com](https://www.ibpindex.com).
2. Guarda la clave en `ibp.key` (raíz del proyecto) o en la variable de entorno `IBP_KEY`.

| Rango | Nivel |
|-------|-------|
| 0–50 | Muy fácil |
| 51–100 | Fácil |
| 101–150 | Moderada |
| 151–250 | Dura |
| 251–400 | Muy dura |
| >400 | Extrema |

---

## Arquitectura

Ver [CLAUDE.md](CLAUDE.md) y [CODEMAP.md](CODEMAP.md) para la referencia técnica, y [CHANGELOG.md](CHANGELOG.md) para el historial de versiones.

```
server.js     Servidor HTTP + API REST (sin framework)
domain/       Lógica pura: parseo GPX, métricas, clasificación, IBP, simplificación, exportación
repo/         Acceso a datos: SQLite y PostgreSQL con la misma API (sql.js para scripts)
blob/         Almacén de los GPX: carpeta local o S3 (Garage, R2, AWS) con la misma API
scripts/      Importación, limpieza, enriquecimiento, copias entre motores…
shared.css    Sistema de diseño común (tema claro/oscuro) + theme.js
TracksGps/    store/ con los GPX originales si el almacén es local (no en git) y _TEMP_/ de entrada
data/         Base SQLite, copias y cachés (no en git)
```
