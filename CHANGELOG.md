# Changelog

## v1.6.0 — 2026-10-23

### Nuevas páginas
- **Comparar tracks** (`/compare?ids=1,2,3`) — mapa Leaflet con N rutas en colores distintos, panel izquierdo compacto (nombre, actividad, distancia, ojo), botón "Altimetría" que abre panel inferior con pestañas por track, columna izquierda de stats (dist, desnivel, tiempo) y perfil SVG con área rellena, grid y tooltip hover
- "Comparar" añadido al `<nav>` de todas las páginas

### Editor (Catálogo)
- Botón **"Comparar (N)"** en la barra de selección, visible cuando hay ≥ 2 tracks seleccionados; abre `/compare` en pestaña nueva
- **Exportar GPX**: nuevo modo "GPX individual" descarga un fichero por track de forma secuencial (el anterior modo "GPX único mezclado" se elimina); ZIP sigue igual

### Visor — perfil de elevación
- Stats reorganizadas como columna izquierda del SVG (en vez de fila superior):
  - 📏 distancia
  - ↗ desnivel+ &nbsp; ↘ desnivel−
  - ⏱ tiempo en movimiento · tiempo total (nuevo — catálogo incluye `movingTime`/`stoppedTime`)
- `white-space: nowrap` para evitar partición en dos líneas
- **Fix:** al seleccionar un tramo arrastrando en el perfil, el track principal permanece visible (antes se ponía a opacidad 0.1); el resaltado del tramo se dibuja encima
- **Fix:** al cerrar el tramo (✕) o el perfil, el track ya no desaparece del mapa

### Admin
- **Pestaña Logs**: visor de `data/operations.log` (NDJSON, auto-rotación 256 KB) con filtros por nivel (info/warn/error), búsqueda, descarga y borrado
- Logging automático de inicio de servidor, arranque/fin/error de cada script ejecutado vía SSE
- **OSM — botón "Solo enriquecer"**: enriquece sin re-descargar datos de Overpass (para tracks ya descargados)
- **OSM — TTL 365 días**: los datos OSM descargados se reutilizan durante un año antes de expirar
- **OSM pre-caché por sierra**: descarga datos Overpass y enriquece todos los tracks de una sierra en un solo paso
- **Fix**: `osm-download` y `osm-precache` no respondían desde Admin (se colgaban sin actualizar el progreso)
- **Pestaña "Acerca de"**: muestra versión actual y enlace al historial de cambios

### Config — Wikiloc
- Flujo **OAuth 2.0** completo (Authorization Code): botón "Conectar con Wikiloc", callback `/auth/wikiloc/callback`, intercambio de código por token, almacenado en `osm-settings.json`
- Sección de credenciales (Client ID / Client Secret) en `<details>` plegable
- Estado de conexión visual ("✓ Conectado" / "Credenciales configuradas" / "No conectado")

### Import Wikiloc
- **Log amigable** con iconos y colores (ok/warn/error/progreso) en vez de texto plano
- Múltiples estrategias de descarga pública antes de recurrir al token API

---

## v1.5.0 — 2026-10-21

- Sistema de estrategias OSM intercambiables
- Pre-caché OSM por sierra (descarga + enriquece en un paso)
- Catálogo: campo `hasOsm` + badge en lista de tracks
- Fix: enriquecimiento batch bloqueado por exceso de vías

## v1.4.0 — 2026-10-20

- Catálogo con `catalog_pts` pre-simplificados en BD
- Endpoint descarga GPX simplificado (`?pts=N`)
- Admin: backup/restore/vacuum/integrity

## v1.3.0 — 2026-10-19

- Waypoints GPX (`<wpt>`) — importación, almacenaje, visualización en `/track`
- Tipos de camino OSM en mapa (coloreado por segmento)
- Subidas detectadas automáticamente en pestaña "Subidas"

## v1.2.0 — 2026-10-18

- Editor CRUD con selección múltiple, exportar GPX/ZIP, enriquecimiento OSM batch
- Importación desde Wikiloc (URL o ID)
- Página de configuración (`/config`) con actividades y parámetros de subida

## v1.1.0 — 2026-10-17

- Visor con perfiles de elevación y selección de tramos
- Filtros avanzados: actividad, sierra, CCAA, distancia, desnivel, IBP, año, tags
- Limpieza/suavizado de tracks (`clean-tracks.js`)

## v1.0.0 — 2026-10-16

- Servidor Node.js puro, SQLite (`node:sqlite`), sin dependencias npm de runtime
- Importación de GPX desde `TracksGps/`, geocodificación inversa (Nominatim)
- Visor Leaflet con mapa de tracks, marcadores por actividad
