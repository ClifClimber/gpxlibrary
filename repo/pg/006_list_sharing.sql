-- Compartir listas de rutas: visibilidad de la lista + comparticiones por usuario.
ALTER TABLE user_lists
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';   -- 'private' | 'public'

CREATE TABLE IF NOT EXISTS user_list_shares (
  list_id   integer NOT NULL REFERENCES user_lists(id) ON DELETE CASCADE,
  user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_edit  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_list_shares_user ON user_list_shares (user_id);
