-- Migration 028: anomalous GPS points found in a track (domain/anomalies.js): JSON text, NULL = not analysed yet
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS anomalies text;
