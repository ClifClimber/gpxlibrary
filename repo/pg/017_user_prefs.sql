-- Preferencias de cada usuario (clave → valor). Por ahora: map_mode = qué marcadores enseña el mapa del visor
-- ('page' solo la página de la lista · 'mixed' página + punto de inicio de las demás · 'all' todas).
ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
