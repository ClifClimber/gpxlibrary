# Changelog

## Sin publicar

### Fase 3 · bloque 0: compresión
- Las respuestas de texto (JSON, HTML, CSS, JS, GPX) se envían comprimidas con brotli o gzip cuando el navegador lo acepta (`http/compress.js`, sin dependencias). El catálogo del visor pasa de 3,1 MB a 0,92 MB y `visor.js` de 76 KB a 21 KB. Las respuestas con ETag se comprimen una vez y se guardan en una caché de 64 MB

---

## v2.13.0 — 2026-10-29

### Listo para abrir a otros usuarios
- **Registro abierto** en `/registro` con aceptación de la nueva **política de privacidad** (`/privacidad`); el admin puede cerrarlo en Admin → Usuarios
- **Recuperar contraseña** en `/restablecer`: enlace de un solo uso que caduca en 1 hora, enviado por email con un cliente SMTP propio sin dependencias (`SMTP_*` y `PUBLIC_URL` en `.env`); sin SMTP el enlace queda en Admin → Logs. Botón de email de prueba en Admin → Usuarios
- **Límite de intentos**: 5 logins fallidos por cuenta en 15 minutos bloquean temporalmente; también registros y peticiones de enlace por conexión
- **Zona de privacidad** (Perfil → Mi perfil): 200 m a 2 km alrededor del inicio y el final de tus rutas que los demás no ven, ni en el mapa ni en el GPX descargado ni en los puntos de paso. El círculo se desplaza y agranda para no delatar el punto real
- **Descargar mis datos** (ZIP con cuenta, rutas en GPX, listas y fotos) y **Borrar mi cuenta** desde el perfil
- **Fotos en S3**: fotos de rutas, imágenes e iconos de actividad pasan al almacén S3 (`photos/…`); `scripts/photos-to-s3.js` copia las existentes. La app ya no guarda nada en disco
- **Enlace directo a listas**: página `/lista?id=N` con mapa y rutas; botones «Abrir» y «Copiar enlace» en Mis listas
- **Logros sin datos imposibles**: las rutas con velocidad media, desnivel por km o km/desnivel por día imposibles no cuentan (límites en Admin → Gamificación) y se listan en Perfil → Logros
- Los registros de la aplicación se borran a los 30 días

### Seguridad
- `POST /api/tracks/export-gpx` exportaba rutas privadas de otros usuarios si se conocía su id: ahora solo exporta las rutas que puedes ver
- Las listas compartidas ya no muestran los nombres de rutas privadas ajenas
- El login solo redirige a páginas de la propia aplicación (`next`)

---

## v2.12.0 — 2026-10-28

### Visor y detalle
- Lista del visor rediseñada: fichas más grandes con icono y actividad, nombre, distancia, desnivel y dificultad, foto y dueño con avatar; panel de 480 px
- «Guardar en lista» desde cada ficha: ventana centrada que indica en qué listas está ya la ruta, permite crear una lista nueva y avisa al guardar; el botón queda marcado
- Trazado al estilo de las aplicaciones de navegación: línea de color con borde negro en el detalle y gris en el visor, más fina

---

## v2.11.0 — 2026-10-28

### Iconos PNG ilustrados por actividad

- **Migración 014**: nueva columna `icon_img text` en `config_activities`
- **Servidor**: `POST /api/config/activities/:id/icon-image` (guarda en `PHOTOS_DIR/act-icons/`), `DELETE` para eliminar, `GET /api/activity-icons/:file` para servir; `USER_API` incluye la ruta de lectura
- **`icons.js`**: `gpxIcon()` ahora renderiza `<img>` cuando la clave empieza por `/`; el estilo inline se elimina para que cada página controle la presentación
- **`shared.css`**: clase base `.gi-img` con `object-fit:contain; border-radius:3px`
- **Visor — lista**: icono PNG cuadrado (30×30), sin fondo de color, sin radio circular cuando hay `icon_img`; fallback a SVG si no hay icono
- **Visor — mapa**: marcador PNG redondo en B&N (`filter:grayscale(1)`) sin fondo de color ni borde blanco cuando hay `icon_img`; fallback al marcador de color habitual
- **`visor.js`**: `actConfig` incluye `icon_img`; `makeActivityIcon` usa `act-marker-img` y `background:transparent` cuando hay icono PNG; `actIconInner` prioriza `icon_img`
- **`ACT_PHOTOS`** ampliado para cubrir todas las actividades con las fotos stock disponibles
- **Admin → Actividades**: tabla muestra solo el icono PNG (28 px) sin el dot SVG de color; formulario elimina el selector SVG, mantiene los campos «Imagen por defecto» e «Icono PNG ilustrado»

### Tarjeta flotante en el mapa al hacer hover en la lista

- Al pasar el ratón por encima de una ruta en el panel lateral, aparece una tarjeta sobre el mapa junto al punto de inicio
- La tarjeta muestra: foto de portada (o foto stock de actividad), nombre de la ruta, sierra/provincia, badge de dificultad IBP con sus colores y distancia + tiempo en movimiento
- Delay de 120 ms para evitar parpadeos en hover rápido; se oculta al salir o al activar la ruta
- Posicionamiento adaptativo: se desplaza a la izquierda si la tarjeta no cabe a la derecha de la pantalla

---

## v2.6.0 — 2026-10-26

### Solo PostgreSQL + S3 (eliminado SQLite y almacén local)
- **SQLite eliminado**: el motor de base de datos es siempre PostgreSQL + PostGIS; `repo/sqlite.js`, `scripts/db.js` y toda la lógica de selección de motor han sido eliminados. Tag `v2.5-con-sqlite` preserva la versión anterior por si se necesita volver
- **Almacén local eliminado**: los GPX originales están siempre en S3 (Garage en local, R2/AWS en producción); `blob/local.js`, `scripts/blob-copy.js` y `STORAGE_DRIVER` han sido eliminados
- `config.js` simplificado: expone solo `DATABASE_URL`, `S3` y `LOCAL_SYNC_DIR`
- `repo/sql.js` ahora es solo Postgres; mantiene la conversión `?` → `$N` para compatibilidad con los scripts
- Admin → Base de datos: eliminados los cards de cambio de motor (SQLite↔Postgres) y de almacén (local↔S3); queda solo estado S3, sincronización local, estadísticas y mantenimiento
- `scripts/migrate-store.js` eliminado (migración ya completada en todas las instalaciones)
- 29 tests pasan

### Cola de trabajos propia
- Operaciones largas (importar, OSM, IBP, limpiar…) ya no bloquean el servidor ni mueren si cierras la página: se ponen en una **cola en la base de datos** y las ejecuta un **worker** que sigue corriendo en segundo plano
- Tablas `jobs` + `job_logs` en PostgreSQL (migración automática al arrancar); el worker reclama trabajos con `SELECT … FOR UPDATE SKIP LOCKED`
- Reintento con backoff exponencial (30 s·2^n), recuperación de trabajos huérfanos tras 90 s sin heartbeat, limpieza automática de más de 30 días
- El worker está **integrado en el servidor** por defecto; en Docker corre como **contenedor independiente** (`worker` en `docker-compose`) con `EMBEDDED_WORKER=0` en `app`; se puede escalar: `docker compose up -d --scale worker=2`
- `queue/index.js` — `createQueue(db)`: API completa (`enqueue`, `claim`, `heartbeat`, `log`, `complete`, `fail`, `release`, `cancel`, `retry`, `get`, `list`, `logs`, `activeCount`, `dataVersion`, `recoverStale`, `prune`)
- `queue/worker.js` — `createWorker(opts)`: lanza el script como proceso hijo, transmite la salida línea a línea, mata en `cancelling`, housekeeping cada 30 s
- `queue/jobs.js` — catálogo de tipos de trabajos con `label`, `maxAttempts` y `scriptOf(type)`
- Admin → **Trabajos**: tabla de los últimos 60 trabajos con estado, duración, última línea, Ver (stream SSE en vivo o histórico), Cancelar y Repetir; auto-refresco cada 3 s mientras el panel está abierto
- La caché del catálogo (`/api/catalog`) se invalida con `dataVersion` al terminar cualquier trabajo, incluyendo los del worker externo
- Tests: `queue/queue.test.js` (6 escenarios)

### Copia local organizada en carpetas
- `scripts/export-folders.js` usa `LOCAL_SYNC_DIR` como destino por defecto (además de `--dest`): exporta todos los tracks a `Actividad/Zona/Nombre.gpx` con los metadatos actuales, sin tocar los originales en S3
- La exportación se **encola automáticamente** tras cada importación exitosa (import-from-temp, wikiloc-import, komoot-import)
- Admin → Base de datos → **Almacén de GPX**: campo de carpeta destino configurable y botón «Exportar ahora»
- En Docker, `LOCAL_SYNC_DIR` del host se monta en `/sync` del contenedor; configurar la ruta en `.env` antes de `docker compose up`
- `scripts/sync-local.js` eliminado (reemplazado por export-folders, que produce una estructura navegable en lugar de ficheros planos con nombre uid)

---

## v2.5.0 — 2026-10-25

### La aplicación en Docker
- `Dockerfile` (Node 24.21, usuario sin privilegios, healthcheck) y servicio `app` en `docker-compose`: `docker compose up -d --build` levanta la aplicación, PostgreSQL y Garage → http://localhost:8081
- El contenedor no guarda datos propios: usa siempre PostgreSQL y S3 (`DATABASE_HOST=db:5432`, `S3_ENDPOINT=http://storage:3900`); copias, logs, caché OSM, ajustes, clave IBP y `_TEMP_` van al volumen `appdata`
- Dentro del contenedor el motor y el almacén los fija el despliegue: los botones de cambio de Admin quedan desactivados
- El servidor acepta `HOST` (0.0.0.0 en el contenedor) y se cierra limpiamente con `docker stop`

### Seguridad
- El servidor ya **no sirve ficheros privados**: antes cualquiera con acceso al puerto, incluida cualquier web abierta en el navegador, podía descargar `.env`, `osm-settings.json`, `ibp.key` o la base de datos. Ahora solo se sirven las páginas, los estilos, los scripts del navegador y `assets/`
- Fuera la cabecera `Access-Control-Allow-Origin: *`, y se rechazan las peticiones que modifican datos si vienen de otra web

---

## v2.4.0 — 2026-10-25

### Almacén de GPX en S3 (Garage) o carpeta local
- Nueva capa `blob/` con dos almacenes intercambiables para los GPX originales: **carpeta local** (`TracksGps/store`, por defecto) y **S3** (Garage en local; Cloudflare R2 o AWS S3 en la nube), elegidos con `STORAGE_DRIVER`
- Cliente S3 propio (firma AWS SigV4 con `node:crypto`), sin dependencias nuevas
- Importar, descargar, borrar, IBP, URLs, exportar en carpetas y almacén leen y escriben a través de esta capa; la importación solo borra el original de `_TEMP_` cuando la ruta ya está en la base de datos
- Garage v2.4.1 en `docker-compose` (servicio `storage`); `scripts/storage-setup.js` genera los secretos en `.env` y crea los buckets y la clave
- `scripts/blob-copy.js` copia los ficheros entre almacenes y comprueba cada uno con su huella SHA-256
- Admin → Base de datos → **Almacén de GPX**: muestra los dos almacenes y cambia de uno a otro sin reiniciar, tras copiar y comprobar; el anterior se conserva
- Tests de contrato contra los dos almacenes (35 tests en total)
- El cambio de motor de base de datos encuentra Docker Desktop también cuando está instalado por usuario

---

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
