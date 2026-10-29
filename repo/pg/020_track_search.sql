-- Fase 3, bloque 7: tabla estrecha con los campos de filtrado de /api/search. Los recuentos, el total y la
-- prefiltración de caja y radio la leen en vez de `tracks` (cuyas filas son anchas por las geometrías).
-- La mantienen triggers sobre `tracks`: ningún camino de escritura (PATCH, importación, limpieza,
-- track-derive, borrado, restauración…) puede dejarla desincronizada.
-- Solo contiene rutas con caja y geom_s1 (las demás nunca salen en la búsqueda).
CREATE TABLE IF NOT EXISTS track_search (
  id             integer PRIMARY KEY,
  owner_id       integer,
  visibility     text NOT NULL,
  hidden         boolean NOT NULL,            -- geom_view IS NULL: la zona de privacidad oculta toda la ruta
  name           text,
  activity       text,
  sierra         text,
  tags           text[] NOT NULL DEFAULT '{}',
  date           text,
  distance       double precision,
  elevation_gain integer,
  grade          integer NOT NULL,            -- 0–5 (difficulty, o el IBP redondeado); -1 sin dato. Misma regla que GRADE_SQL
  ibp_sort       integer NOT NULL,            -- IBP redondeado de su grupo de actividad (9999 sin dato), para ordenar
  circular       boolean NOT NULL,
  search_text    text,
  box            geometry(Geometry, 4326) NOT NULL   -- caja de geom_s1 (ST_Envelope)
);

CREATE INDEX IF NOT EXISTS track_search_box_gix   ON track_search USING gist (box);
CREATE INDEX IF NOT EXISTS track_search_text_trgm ON track_search USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS track_search_owner_ix  ON track_search (owner_id);
-- Un índice por orden de /api/search (la página se lee en orden sin ordenar todas las coincidencias)
CREATE INDEX IF NOT EXISTS track_search_name_ix   ON track_search (name COLLATE "es-x-icu", date DESC NULLS LAST, name COLLATE "C", id);
CREATE INDEX IF NOT EXISTS track_search_date_ix   ON track_search (date DESC NULLS LAST, name COLLATE "C", id);
CREATE INDEX IF NOT EXISTS track_search_dist_ix   ON track_search (distance, date DESC NULLS LAST, name COLLATE "C", id);
CREATE INDEX IF NOT EXISTS track_search_ele_ix    ON track_search (elevation_gain, date DESC NULLS LAST, name COLLATE "C", id);

-- tags (JSON como texto) → text[]; un JSON inválido no debe impedir escribir la ruta
CREATE OR REPLACE FUNCTION track_search_tags(j text) RETURNS text[] AS $$
BEGIN
  IF j IS NULL OR j = '' THEN RETURN '{}'; END IF;
  RETURN ARRAY(SELECT json_array_elements_text(j::json));
EXCEPTION WHEN others THEN
  RETURN '{}';
END $$ LANGUAGE plpgsql IMMUTABLE;

-- Fila de track_search de una ruta (NULL si no es buscable). Las listas de actividades de ciclismo y carrera
-- son las de CYCLING/RUNNING en repo/search.js (un test comprueba que coinciden).
CREATE OR REPLACE FUNCTION track_search_sync() RETURNS trigger AS $$
DECLARE
  v numeric;
  g integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM track_search WHERE id = OLD.id;
    RETURN NULL;
  END IF;
  IF NEW.sw_lat IS NULL OR NEW.geom_s1 IS NULL THEN
    DELETE FROM track_search WHERE id = NEW.id;
    RETURN NULL;
  END IF;
  v := round((CASE WHEN NEW.activity = ANY (ARRAY['MTB','MTB Enduro','Mtb','Gravel','Bikepacking','Ciclismo de carretera']) THEN NEW.ibp_bicycle
                   WHEN NEW.activity = ANY (ARRAY['Trail Running','Running']) THEN NEW.ibp_running
                   ELSE NEW.ibp_hiking END)::numeric);
  g := COALESCE(NEW.difficulty, CASE WHEN v IS NULL THEN -1 WHEN v < 0 THEN -1 WHEN v <= 50 THEN 0 WHEN v <= 100 THEN 1
                                     WHEN v <= 150 THEN 2 WHEN v <= 250 THEN 3 WHEN v <= 400 THEN 4 ELSE 5 END);
  INSERT INTO track_search (id, owner_id, visibility, hidden, name, activity, sierra, tags, date, distance, elevation_gain,
                            grade, ibp_sort, circular, search_text, box)
  VALUES (NEW.id, NEW.owner_id, NEW.visibility, NEW.geom_view IS NULL, NEW.name, NEW.activity, NEW.sierra,
          track_search_tags(NEW.tags), NEW.date, NEW.distance, NEW.elevation_gain, g, COALESCE(v::integer, 9999),
          COALESCE(NEW.circular, 0) <> 0, NEW.search_text, ST_Envelope(NEW.geom_s1))
  ON CONFLICT (id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id, visibility = EXCLUDED.visibility, hidden = EXCLUDED.hidden, name = EXCLUDED.name,
    activity = EXCLUDED.activity, sierra = EXCLUDED.sierra, tags = EXCLUDED.tags, date = EXCLUDED.date,
    distance = EXCLUDED.distance, elevation_gain = EXCLUDED.elevation_gain, grade = EXCLUDED.grade,
    ibp_sort = EXCLUDED.ibp_sort, circular = EXCLUDED.circular, search_text = EXCLUDED.search_text, box = EXCLUDED.box;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION track_search_truncate() RETURNS trigger AS $$
BEGIN
  TRUNCATE track_search;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS track_search_ins ON tracks;
DROP TRIGGER IF EXISTS track_search_upd ON tracks;
DROP TRIGGER IF EXISTS track_search_del ON tracks;
DROP TRIGGER IF EXISTS track_search_trunc ON tracks;
CREATE TRIGGER track_search_ins AFTER INSERT ON tracks FOR EACH ROW EXECUTE FUNCTION track_search_sync();
-- Solo las columnas que copia (un UPDATE de geom, ele o points no la toca)
CREATE TRIGGER track_search_upd AFTER UPDATE OF owner_id, visibility, name, activity, sierra, tags, date, distance,
  elevation_gain, difficulty, ibp_bicycle, ibp_hiking, ibp_running, circular, search_text, sw_lat, geom_s1, geom_view
  ON tracks FOR EACH ROW EXECUTE FUNCTION track_search_sync();
CREATE TRIGGER track_search_del AFTER DELETE ON tracks FOR EACH ROW EXECUTE FUNCTION track_search_sync();
CREATE TRIGGER track_search_trunc AFTER TRUNCATE ON tracks FOR EACH STATEMENT EXECUTE FUNCTION track_search_truncate();

-- Relleno inicial
INSERT INTO track_search (id, owner_id, visibility, hidden, name, activity, sierra, tags, date, distance, elevation_gain,
                          grade, ibp_sort, circular, search_text, box)
SELECT t.id, t.owner_id, t.visibility, t.geom_view IS NULL, t.name, t.activity, t.sierra, track_search_tags(t.tags), t.date,
       t.distance, t.elevation_gain,
       COALESCE(t.difficulty, CASE WHEN x.v IS NULL THEN -1 WHEN x.v < 0 THEN -1 WHEN x.v <= 50 THEN 0 WHEN x.v <= 100 THEN 1
                                   WHEN x.v <= 150 THEN 2 WHEN x.v <= 250 THEN 3 WHEN x.v <= 400 THEN 4 ELSE 5 END),
       COALESCE(x.v::integer, 9999), COALESCE(t.circular, 0) <> 0, t.search_text, ST_Envelope(t.geom_s1)
FROM tracks t
CROSS JOIN LATERAL (SELECT round((CASE WHEN t.activity = ANY (ARRAY['MTB','MTB Enduro','Mtb','Gravel','Bikepacking','Ciclismo de carretera']) THEN t.ibp_bicycle
                                       WHEN t.activity = ANY (ARRAY['Trail Running','Running']) THEN t.ibp_running
                                       ELSE t.ibp_hiking END)::numeric) AS v) x
WHERE t.sw_lat IS NOT NULL AND t.geom_s1 IS NOT NULL
ON CONFLICT (id) DO NOTHING;
ANALYZE track_search;
