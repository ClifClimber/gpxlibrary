-- Sesiones de grabación de cada ruta (JSON [{s,e,km}], s/e en segundos epoch), partidas por paradas de
-- más de 1 h. Permite contar los días con actividad y detectar ficheros unidos de fechas distintas
-- con los umbrales que se configuren en Admin → Gamificación, sin volver a leer el GPX.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS time_segments text;
