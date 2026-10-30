-- Migration 026: track_ratings, track_done, notifications; enhance track_comments; rating cols in track_search

-- Enhance track_comments
ALTER TABLE track_comments
  ADD COLUMN IF NOT EXISTS parent_id  integer REFERENCES track_comments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_at  timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_at  timestamptz;
CREATE INDEX IF NOT EXISTS track_comments_parent_idx ON track_comments(parent_id) WHERE parent_id IS NOT NULL;

-- Ratings (1–5 stars, one per user per track)
CREATE TABLE IF NOT EXISTS track_ratings (
  track_id   integer NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  stars      smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (track_id, user_id)
);

-- "I've done it" per user per track
CREATE TABLE IF NOT EXISTS track_done (
  track_id   integer NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  done_on    date,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (track_id, user_id)
);

-- Aggregate rating in track_search
ALTER TABLE track_search
  ADD COLUMN IF NOT EXISTS rating_avg   real,
  ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION sync_track_rating() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid integer := COALESCE(NEW.track_id, OLD.track_id);
BEGIN
  UPDATE track_search SET
    rating_avg   = (SELECT AVG(stars)::real FROM track_ratings WHERE track_id = tid),
    rating_count = (SELECT CAST(COUNT(*) AS INTEGER) FROM track_ratings WHERE track_id = tid)
  WHERE id = tid;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS rating_sync ON track_ratings;
CREATE TRIGGER rating_sync
AFTER INSERT OR UPDATE OR DELETE ON track_ratings
FOR EACH ROW EXECUTE FUNCTION sync_track_rating();

-- Notifications (groundwork for block F)
CREATE TABLE IF NOT EXISTS notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  actor_id   integer REFERENCES users(id) ON DELETE SET NULL,
  track_id   integer REFERENCES tracks(id) ON DELETE CASCADE,
  comment_id integer,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  read_at    timestamptz
);
CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications(user_id, created_at DESC);
