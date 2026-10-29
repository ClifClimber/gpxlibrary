-- Zona de privacidad: metros alrededor del inicio y del final de cada ruta que no ven los demás (0 = sin zona).
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_radius integer NOT NULL DEFAULT 0;
-- Aceptación de la política de privacidad (registro abierto)
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

-- Enlaces de un solo uso para restablecer la contraseña (se guarda el hash del token, nunca el token)
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);
