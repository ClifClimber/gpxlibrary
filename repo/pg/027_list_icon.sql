-- Migration 027: icon of each list (key of icons.js, chosen by its owner; NULL = default bookmark)
ALTER TABLE user_lists ADD COLUMN IF NOT EXISTS icon text;
