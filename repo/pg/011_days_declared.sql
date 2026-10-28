-- Duración declarada por el usuario al subir/editar la ruta. Manda sobre la detección automática.
--   NULL → detectar automáticamente · 1 → un día · N ≥ 2 → N días · 0 → varios días (sin número)
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS days_declared integer;
