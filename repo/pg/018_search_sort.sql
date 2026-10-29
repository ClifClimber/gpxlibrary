-- Fase 3, bloque 3: índices para leer una página de /api/search en orden sin ordenar todas las coincidencias.
CREATE INDEX IF NOT EXISTS tracks_name_es_ix   ON tracks (name COLLATE "es-x-icu");
CREATE INDEX IF NOT EXISTS tracks_date_desc_ix ON tracks (date DESC NULLS LAST);
