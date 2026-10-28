-- Icono (clave de icons.js) e imagen por defecto de cada actividad, configurables en Admin → Actividades.
-- La imagen es la que muestra el visor cuando la ruta no tiene fotos propias.
ALTER TABLE config_activities ADD COLUMN IF NOT EXISTS icon  text;
ALTER TABLE config_activities ADD COLUMN IF NOT EXISTS image text;   -- URL (/assets/... o /api/activity-images/...)

-- Valores iniciales: los que estaban fijos en el visor
UPDATE config_activities SET icon = CASE name
    WHEN 'MTB'                   THEN 'mtb'
    WHEN 'MTB Enduro'            THEN 'mtb'
    WHEN 'Gravel'                THEN 'gravel'
    WHEN 'Bikepacking'           THEN 'bikepacking'
    WHEN 'Ciclismo de carretera' THEN 'road-bike'
    WHEN 'Trail Running'         THEN 'trail-run'
    WHEN 'Running'               THEN 'run'
    WHEN 'Senderismo'            THEN 'hike'
    WHEN 'Montañismo'            THEN 'peak'
    WHEN 'Apinismo'              THEN 'peak'
    WHEN 'Alpinismo'             THEN 'peak'
    WHEN 'Crestas y Trepadas'    THEN 'ridge'
    WHEN 'Escalada'              THEN 'climb'
    WHEN 'Ferratas'              THEN 'via-ferrata'
    WHEN 'Esquí Travesia'        THEN 'ski-touring'
    WHEN 'Esquí de montaña'      THEN 'ski-touring'
    WHEN 'Kayak'                 THEN 'kayak'
    ELSE 'pin' END
WHERE icon IS NULL;

UPDATE config_activities SET image = CASE name
    WHEN 'MTB'            THEN '/assets/activities/mtb.jpg'
    WHEN 'MTB Enduro'     THEN '/assets/activities/mtb.jpg'
    WHEN 'Gravel'         THEN '/assets/activities/gravel.jpg'
    WHEN 'Trail Running'  THEN '/assets/activities/trail-running.jpg'
    WHEN 'Running'        THEN '/assets/activities/trail-running.jpg'
    WHEN 'Montañismo'     THEN '/assets/activities/montanismo.jpg'
    WHEN 'Apinismo'       THEN '/assets/activities/alpinismo.jpg'
    WHEN 'Alpinismo'      THEN '/assets/activities/alpinismo.jpg'
    WHEN 'Ferratas'       THEN '/assets/activities/ferratas.jpg'
    WHEN 'Esquí Travesia' THEN '/assets/activities/travesia.jpg'
    ELSE NULL END
WHERE image IS NULL;
