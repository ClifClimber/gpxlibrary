# gpxlibrary

Catálogo de rutas GPS (GPX). El índice (`catalog/index.json`) guarda una entrada
por archivo distinto, identificada por el SHA-256 de su contenido, con los datos
de la ruta ya calculados. Al volver a escanear solo se parsean los GPX nuevos.

## Uso

```sh
python3 scripts/scan.py /ruta/a/TracksGps                 # actualiza catalog/index.json
python3 scripts/scan.py /ruta/a/TracksGps --dry-run       # solo muestra qué ha cambiado
python3 scripts/scan.py /ruta/a/TracksGps --csv catalogo_rutas.csv
```

El informe distingue rutas nuevas, modificadas (mismo nombre, contenido
distinto), eliminadas y movidas o renombradas (mismo contenido, otra ruta). Los
archivos idénticos en varias carpetas comparten una entrada con varias `paths`.
Los archivos que no son `.gpx` se listan en `ignored`.

`--csv` exporta el catálogo con las columnas de `catalogo_rutas.csv` sin volver a
leer los GPX. La disciplina sale de la categoría de Wikiloc, si el GPX la trae;
si no, de la carpeta o el nombre, de Trailforks o de la velocidad en movimiento.

No necesita dependencias: solo Python 3.9 o superior.

## Campos del índice

`nombre_gpx`, `km`, `desnivel_pos_m` y `desnivel_neg_m` (con umbral de 5 m),
`alt_max_m`, `alt_min_m`, `duracion_total`, `tiempo_movimiento`, `fecha`, `tipo`
(Circular o Lineal), `inicio_lat`, `inicio_lon`, `wikiloc_cat`, `wikiloc_id`,
`wikiloc_url`, `origen`, `creator`, `velocidad_mov_kmh`, `puntos`, `waypoints`,
`nota`, más `paths`, `size` y `added` (cuándo entró en el índice).

## Tests

```sh
python3 -m unittest discover -s tests
```
