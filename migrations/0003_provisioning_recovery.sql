PRAGMA foreign_keys = ON;

ALTER TABLE provisioning_jobs ADD COLUMN request_hash TEXT;
ALTER TABLE provisioning_jobs ADD COLUMN d1_database_id TEXT;
ALTER TABLE provisioning_jobs ADD COLUMN rollback_status TEXT
  CHECK (rollback_status IN ('not_required', 'completed', 'failed'));
ALTER TABLE provisioning_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1
  CHECK (attempt_count > 0);

CREATE INDEX provisioning_jobs_remote_d1_idx
  ON provisioning_jobs(d1_database_id);
