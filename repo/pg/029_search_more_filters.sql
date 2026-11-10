-- Visor: filtros de duración (tiempo en marcha) y grado de ferrata (dificultad indicada por el autor) sobre la
-- tabla estrecha de búsqueda. Se añaden las dos columnas, el trigger las copia y se rellenan una vez.
ALTER TABLE track_search
  ADD COLUMN IF NOT EXISTS moving_time integer,
  ADD COLUMN IF NOT EXISTS difficulty  integer;

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
                            grade, ibp_sort, circular, search_text, box, moving_time, difficulty)
  VALUES (NEW.id, NEW.owner_id, NEW.visibility, NEW.geom_view IS NULL, NEW.name, NEW.activity, NEW.sierra,
          track_search_tags(NEW.tags), NEW.date, NEW.distance, NEW.elevation_gain, g, COALESCE(v::integer, 9999),
          COALESCE(NEW.circular, 0) <> 0, NEW.search_text, ST_Envelope(NEW.geom_s1), NEW.moving_time, NEW.difficulty)
  ON CONFLICT (id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id, visibility = EXCLUDED.visibility, hidden = EXCLUDED.hidden, name = EXCLUDED.name,
    activity = EXCLUDED.activity, sierra = EXCLUDED.sierra, tags = EXCLUDED.tags, date = EXCLUDED.date,
    distance = EXCLUDED.distance, elevation_gain = EXCLUDED.elevation_gain, grade = EXCLUDED.grade,
    ibp_sort = EXCLUDED.ibp_sort, circular = EXCLUDED.circular, search_text = EXCLUDED.search_text, box = EXCLUDED.box,
    moving_time = EXCLUDED.moving_time, difficulty = EXCLUDED.difficulty;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS track_search_upd ON tracks;
CREATE TRIGGER track_search_upd AFTER UPDATE OF owner_id, visibility, name, activity, sierra, tags, date, distance,
  elevation_gain, difficulty, ibp_bicycle, ibp_hiking, ibp_running, circular, search_text, sw_lat, geom_s1, geom_view, moving_time
  ON tracks FOR EACH ROW EXECUTE FUNCTION track_search_sync();

UPDATE track_search s SET moving_time = t.moving_time, difficulty = t.difficulty
  FROM tracks t WHERE t.id = s.id AND (s.moving_time IS DISTINCT FROM t.moving_time OR s.difficulty IS DISTINCT FROM t.difficulty);

-- «La he hecho» de un usuario
CREATE INDEX IF NOT EXISTS track_done_user_idx ON track_done (user_id);

-- Fecha imposible (1899-12-30 es el «cero» de Excel, no un día real): sin fecha
UPDATE tracks SET date = NULL WHERE date LIKE '1899%';
