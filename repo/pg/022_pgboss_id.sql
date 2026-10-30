-- Link jobs to pg-boss entries (null for jobs created before the migration)
ALTER TABLE jobs ADD COLUMN pgboss_id uuid;
CREATE INDEX idx_jobs_pgboss ON jobs (pgboss_id) WHERE pgboss_id IS NOT NULL;
