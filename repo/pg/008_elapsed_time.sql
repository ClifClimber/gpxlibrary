-- Tiempo total transcurrido (primer → último punto con hora), incluidas noches y paradas largas.
-- moving_time/stopped_time ignoran los huecos de más de 5 min, así que no sirven para saber si una
-- ruta duró varios días; este campo sí. Se rellena al importar y con scripts/backfill-elapsed.js.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS elapsed_time integer;
