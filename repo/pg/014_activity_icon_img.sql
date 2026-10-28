-- Imagen PNG ilustrada como icono de actividad (alternativa a la clave SVG de icons.js).
-- Se sube en Admin → Actividades. Se sirve en /api/activity-icons/:file.
ALTER TABLE config_activities ADD COLUMN IF NOT EXISTS icon_img text;
