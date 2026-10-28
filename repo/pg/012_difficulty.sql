-- Grado de dificultad elegido por el usuario (escala del IBP): 0 Muy fácil · 1 Fácil · 2 Moderada ·
-- 3 Dura · 4 Muy dura · 5 Extrema. NULL → el grado se calcula a partir del IBP de la ruta.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS difficulty integer;
