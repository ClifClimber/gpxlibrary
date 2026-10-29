-- Fase 3, bloque 6: el visor ya no descarga el catálogo (usa /api/search y las geometrías derivadas de la 016),
-- así que la polilínea precalculada de 300 puntos por ruta sobra.
ALTER TABLE tracks DROP COLUMN IF EXISTS catalog_pts;
