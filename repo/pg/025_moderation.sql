-- Migration 025: moderation – blocks, reports, tracks.comments_enabled
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  reporter_id integer REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  target_id   integer NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  resolved_by integer REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  action      text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('track','photo','user','comment'))
);
CREATE INDEX IF NOT EXISTS reports_status_idx  ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_target_idx  ON reports(kind, target_id);

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS comments_enabled boolean NOT NULL DEFAULT true;
