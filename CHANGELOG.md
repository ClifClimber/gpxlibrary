# Changelog

## v2.3.0 — 2026-10-25

### Todas las operaciones funcionan con PostgreSQL
- Nueva capa SQL neutra `repo/sql.js` (`openSql()`): consultas asíncronas con `?`, transacciones, marcas de tiempo (`NOW`, `NOW_TEXT`), orden byte a byte (`BIN`) y lectura/escritura de puntos GPS (filas en SQLite, geometría PostGIS en PostgreSQL)
- Portados a ella todos los scripts: **importar** (y por tanto Wikiloc y Komoot), **IBP**, **limpiar**, **tipos de camino OSM** (enriquecer, precaché y las tres estrategias), **ubicación** (Nominatim), **URLs**, **catálogo** (`backfill-catalog-pts`, ahora con la función de `domain/`), **exportar en carpetas** y **almacén** (`migrate-store`)
- Admin con PostgreSQL: estadísticas, caché OSM, recuento por actividad, **optimizar** (`VACUUM (ANALYZE)`) y **comprobar integridad** (geometrías válidas y que altitudes y recuentos coinciden con los puntos)
- Verificado ejecutando cada operación en los dos motores con los mismos datos: resultados idénticos campo a campo, mismas exportaciones y mismas respuestas del servidor
- Solo la exportación heredada a `catalog-data.js` (`/api/db/export`, que no usa ninguna página) sigue siendo exclusiva de SQLite

### Copias de seguridad con los dos motores
- Las copias son siempre un fichero SQLite comprimido (`data/backups/tracks-….db.gz`); con PostgreSQL se vuelcan con `db-copy.js`, que comprueba la copia antes de guardarla
- Cualquier copia se puede restaurar en cualquiera de los dos motores
- La copia diaria automática al arrancar se hace también con PostgreSQL

### Otros
- Eliminada la opción **«Borrar todo»** (diálogo del editor y endpoint `/api/tracks/delete-all`)
- `clean-tracks --reset` recalcula la vista previa del catálogo con los puntos originales
- `NO_OPEN=1` arranca el servidor sin abrir el navegador
- Los mensajes «Solo disponible con SQLite» de Admin se sustituyen por el error real si lo hay

---

## v2.2.0 — 2026-10-25

### Cambiar de motor de base de datos desde Admin
- Nueva tarjeta **Motor de base de datos** en Admin → Base de datos: muestra SQLite y PostgreSQL con sus rutas, cuál está en uso y si PostgreSQL responde
- Botón **Cambiar a PostgreSQL / Cambiar a SQLite** con el progreso en pantalla:
  1. comprueba PostgreSQL y, si no responde, arranca el contenedor de Docker
  2. al volver a SQLite, hace antes una copia de seguridad
  3. copia los datos del motor actual al nuevo y compara los dos consulta a consulta
  4. cambia de motor sin reiniciar el servidor y lo guarda en `.env` para los siguientes arranques
- Si algo falla o los motores no coinciden, se mantiene el motor anterior
- La copia hacia SQLite se escribe en un fichero temporal y solo sustituye la base principal tras comprobarla
- No se permite cambiar mientras hay una importación u otro proceso en marcha

### Otros
- Con PostgreSQL, estadísticas, copias de seguridad y caché OSM indican «Solo disponible con SQLite» en vez de mostrar errores
- La copia de seguridad diaria automática solo se hace cuando SQLite es el motor activo

---

## v2.1.0 — 2026-10-25

Fase 1 hacia la nube: **la aplicación funciona igual con SQLite o con PostgreSQL + PostGIS.**

### Dos motores de base de datos intercambiables
- Nueva capa de acceso a datos `repo/` con una implementación para **SQLite** y otra para **PostgreSQL + PostGIS**; se elige con `DB_DRIVER=sqlite|postgres` en `.env` (por defecto SQLite, sin cambios para quien no lo toque)
- El visor, el catálogo, el detalle, editar / mover / borrar rutas (una o en bloque), las etiquetas, las zonas y la configuración de actividades y sierras pasan por esta capa
- Verificado con los datos reales: las respuestas del servidor son **idénticas byte a byte** con los dos motores (391 rutas, 1.092.850 puntos)
- Con PostgreSQL, las operaciones aún no portadas (importar, enriquecer con OSM, IBP, limpiar, copias de seguridad, exportar en carpetas) responden «aún no disponible con PostgreSQL» en lugar de fallar

### PostgreSQL en local con Docker
- `docker-compose.yml` con PostgreSQL 17 + PostGIS 3.5, accesible solo desde el propio equipo
- Esquema en `repo/pg/001_init.sql` aplicado con migraciones numeradas; los puntos se guardan como geometría PostGIS más un array de altitudes
- Configuración en `.env` (plantilla `.env.example`); `.env` no va a git

### Copiar datos entre motores
- `scripts/db-copy.js --to postgres` y `--to sqlite` (a un fichero nuevo; nunca sobrescribe la base principal sin `--replace`), conservando los identificadores de las rutas
- Al terminar compara los dos motores consulta a consulta; `--verify` hace solo la comparación
- Atajos: `npm run db:copy-to-postgres`, `db:copy-to-sqlite`, `db:compare`

### Calidad
- 16 tests nuevos que ejecutan las mismas comprobaciones contra SQLite y PostgreSQL (`npm test`: 27 en total)
- Orden de listas totalmente determinista en los dos motores (desempate por id; rutas sin fecha al final)
- «Acerca de» indica qué motor de base de datos está en uso

### Dependencias
- Primera dependencia npm: `pg` (cliente de PostgreSQL), solo se carga con `DB_DRIVER=postgres`

---

## v2.0.0 — 2026-10-24

Primera versión de la fase 1 hacia la nube (rama `cloud/fase-1`). **Cambia cómo se guardan los ficheros.**

### Almacén inmutable de GPX
- Los originales se guardan en `TracksGps/store/{uid}.gpx` y **no se mueven ni se reescriben nunca**; nombre, actividad, sierra, notas y URL viven solo en la base de datos
- Nuevas columnas `uid` (clave estable del fichero) y `sha256` (huella del contenido)
- Editar, mover o editar en bloque ya no mueve ficheros entre carpetas
- `scripts/migrate-store.js` migra la biblioteca existente (`--dry-run` para simular, `--revert <manifiesto>` para deshacer); también desde Admin → Gestión de Tracks → «Almacén de ficheros»

### Importación
- **Duplicados**: si el fichero es idéntico a uno ya guardado se avisa («Ya existe … id=N») y se descarta la copia
- Las rutas de baja confianza ya no se apartan a `_TEMP_/_REVIEW_`: se importan con la etiqueta **revisar**

### Exportar
- **Exportar en carpetas** (Admin → Gestión de Tracks): genera `Actividad/Sierra/Nombre.gpx` en la carpeta que elijas, con los datos actuales de cada ruta y sin sobrescribir nada
- Descargar el GPX original usa el nombre de la ruta y aplica los metadatos actuales al vuelo
- El ZIP «en árbol» se genera desde la base de datos

### Retirado
- «Reorganizar carpetas» y «Escribir atributos a GPX» (contradicen el almacén inmutable)
- `TracksGps/` deja de versionarse en git (datos personales, como la base de datos)

### Limpieza de datos
- Eliminadas 3 rutas cuyo GPX ya no existía en disco (ids 406, 615, 756)

---

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
