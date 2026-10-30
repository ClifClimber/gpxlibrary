-- Migration 023: follows table (phase 4 block C groundwork, needed by the follow button on profiles)
CREATE TABLE IF NOT EXISTS follows (
  follower_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows(followee_id);
