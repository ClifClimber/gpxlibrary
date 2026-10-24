# Changelog

## v1.8.0 — 2026-10-24

### Nueva página: Trazar (`/trazar`)
- **Dibujar rutas** haciendo clic en el mapa, en línea recta o **siguiendo caminos** (a pie / en bici, vía BRouter)
- **Editar** puntos: arrastrar, insertar pulsando en la línea, borrar con clic derecho; **recortar** quedándose con el inicio o el final
- **Puntos de paso**: añadir, renombrar, mover y borrar; se guardan como `<wpt>` en el GPX
- **Unir rutas**: buscador "Añadir otra ruta al final" que orienta el tramo y rellena el hueco; desde Comparar, botón **Unir**
- Invertir, cerrar en circular, **simplificar** (RDP 5 m), deshacer/rehacer (Ctrl+Z / Ctrl+Y)
- Distancia, subida, bajada y **perfil de elevación** en vivo; altitudes con Open-Meteo y botón **Recalcular altitudes** para corregir saltos del GPS
- Guardar reutiliza la importación (ubicación, sierra, OSM, IBP) y abre el detalle. **Editar un track existente crea una copia**: el GPX original nunca se modifica
- Accesos: "Trazar" en la barra, "Nueva ruta" en el catálogo y "Editar trazado" en el detalle

### Modo oscuro
- Tokens oscuros en `shared.css` (sigue al sistema o se elige con el botón ☀/☾ de la barra; se recuerda)
- Colores fijos sustituidos por variables; badges, IBP y logs legibles en ambos temas
- Capas de mapa **Claro** y **Oscuro** (lienzo gris de Esri; CARTO pasó a exigir API key)

### Admin + Config unificados
- Actividades, Sierras / Zonas, Provincias & CCAA y Parámetros son ahora pestañas de **Admin**; cada pestaña tiene enlace propio (`/admin#params`)
- `/config` redirige a Admin y el retorno OAuth de Wikiloc vuelve a la pestaña Parámetros

### Rendimiento
- El servidor escucha también en IPv6 (`::1`): elimina ~200 ms de espera en cada petición a `localhost`
- `ETag`/304 en ficheros estáticos y en `/api/catalog` (3 MB): no se vuelven a descargar si no han cambiado
- Checkpoint del WAL de SQLite al arrancar y tras cada script (pasaba de 74 MB a 0)
- Admin: la lista de caché OSM usa la fecha del fichero en vez de leer los JSON completos (11 s → milisegundos); las estadísticas ya no escanean el disco
- Visor: la lista no se reconstruye si el resultado del filtro no cambia
- Log `[slow]` en consola para peticiones de más de 80 ms

### Importación
- Aplica automáticamente los datos OSM de la caché por sierra al importar
- Al terminar: con un track abre su **detalle**; con varios, el **visor filtrado** por los importados (`/?ids=…`)
- Se muestra solo el resumen, sin el log en bruto de fondo

### Visor y catálogo
- **Agrupación de marcadores** en clústeres; encuadre inicial en la zona donde están la mayoría de rutas
- Columna **#** (ID de importación) en el catálogo y orden "Última importación" en el visor; se quita la columna Notas
- Iconos SVG para circular / lineal

### Detalle de track
- Panel reorganizado: cifras principales, franja con cotas, tiempo en marcha y tipo de recorrido; sin datos duplicados
- Etiquetas como chips con "+ Añadir"; archivo y fuente en un bloque plegable; botón de fuente original en la cabecera
- Pestañas cortas en una sola fila

### Comparar
- Tarjetas por ruta con distancia y desnivel en **barras comparativas**, IBP y tiempo
- Buscador para **añadir rutas del catálogo** sin salir; botones con texto (Encuadrar, Ocultar, Vaciar, Perfiles)
- Recuerda las rutas al volver a la página

### Correcciones
- El filtro Circular / Lineal del visor no funcionaba (faltaba el campo en el catálogo)
- Comparar: al quitar una ruta, el clic en el mapa resaltaba la equivocada; colores repetidos; error al ocultar la ruta del perfil abierto
- Admin: "Reducción pts" mostraba 100% sin tracks limpiados
- Etiquetas y nombres con comillas o `<` rompían el HTML (ahora se escapan)

---

## v1.7.0 — 2026-10-23

- **Detección de cuestas recalibrada** contra los puntos simplificados de `/api/tracks/:id`; recorte de inicio y final de cada cuesta y métricas sobre elevación bruta
- Nuevos valores por defecto de cuestas (`minGain` 70 m, `minGrad` 3,5 %) y clave `gpx-climb-params-v2`
- **Importar desde Komoot** (tours públicos)
- **Arrastrar y soltar GPX** al comparador o al catálogo
- Comparar: panel de altimetría flotante sincronizado con el mapa y pestaña "∥ Todos"
- Resumen de importación con el recuento real
- Fix: `/api/import/wikiloc` fallaba sin URL

---

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
