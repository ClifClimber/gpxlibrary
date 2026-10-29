-- Fase 3, bloque 2: geometrías derivadas por ruta (lo que ven los demás, simplificado) y texto de búsqueda.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS geom_view   geometry(LineString, 4326);
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS geom_s1     geometry(LineString, 4326);
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS geom_s2     geometry(LineString, 4326);
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS start_point geometry(Point, 4326);
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS search_text text;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS derived_at  timestamptz;

CREATE INDEX IF NOT EXISTS tracks_geom_s1_gix     ON tracks USING gist (geom_s1);
CREATE INDEX IF NOT EXISTS tracks_geom_s2_gix     ON tracks USING gist (geom_s2);
CREATE INDEX IF NOT EXISTS tracks_start_point_gix ON tracks USING gist (start_point);
CREATE INDEX IF NOT EXISTS tracks_search_text_trgm ON tracks USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_visibility_owner_ix ON tracks (visibility, owner_id);
CREATE INDEX IF NOT EXISTS tracks_distance_ix       ON tracks (distance);
CREATE INDEX IF NOT EXISTS tracks_elevation_gain_ix ON tracks (elevation_gain);
-- tags es texto (JSON como cadena, no jsonb): no se crea índice de expresión; la búsqueda por etiquetas usa search_text.
