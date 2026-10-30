-- Fase 4, bloque A: páginas públicas (sin sesión) e indexables.
-- web_visible: las rutas públicas del usuario se ven en Internet sin iniciar sesión (activado para todos;
--   el usuario puede desactivarlo en Perfil → Privacidad). profile_public: su perfil /u/{usuario} es público.
ALTER TABLE users ADD COLUMN IF NOT EXISTS web_visible    boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_public boolean NOT NULL DEFAULT true;
-- Una ruta con web de origen (tracks.url, p. ej. Wikiloc) puede ser de otra persona: no se ve sin sesión ni se
-- indexa hasta que su dueño confirma que es suya.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS source_confirmed boolean NOT NULL DEFAULT false;
