-- Ajustes de la aplicación editables desde Admin (clave → JSON). Ejemplo: 'gamification'.
-- Vive en la base de datos para que lo compartan app y worker y entre en las copias de seguridad.
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,              -- JSON
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
