-- Foto de portada de cada ruta + miniatura de cada foto (para listas como la del visor).
ALTER TABLE track_photos ADD COLUMN IF NOT EXISTS thumb_filename text;   -- fichero pequeño en PHOTOS_DIR (opcional)

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS cover_photo_id integer;
-- Diferida: una restauración carga tracks antes que track_photos dentro de la misma transacción.
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_cover_photo_fk;
ALTER TABLE tracks ADD CONSTRAINT tracks_cover_photo_fk FOREIGN KEY (cover_photo_id)
  REFERENCES track_photos (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- Las rutas que ya tienen fotos estrenan portada: la primera
UPDATE tracks t SET cover_photo_id = p.id
FROM (SELECT DISTINCT ON (track_id) track_id, id FROM track_photos ORDER BY track_id, position, id) p
WHERE p.track_id = t.id AND t.cover_photo_id IS NULL;
