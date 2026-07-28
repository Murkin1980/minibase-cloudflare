PRAGMA foreign_keys = ON;

CREATE TABLE management_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  rotated_from_key_id TEXT REFERENCES management_keys(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

ALTER TABLE audit_events ADD COLUMN actor_key_id TEXT REFERENCES management_keys(id) ON DELETE SET NULL;
ALTER TABLE audit_events ADD COLUMN outcome TEXT NOT NULL DEFAULT 'success'
  CHECK (outcome IN ('success', 'denied', 'failed'));
ALTER TABLE audit_events ADD COLUMN metadata TEXT;

CREATE INDEX management_keys_active_idx
  ON management_keys(key_hash, revoked_at, expires_at);
CREATE INDEX audit_events_actor_created_idx
  ON audit_events(actor_key_id, created_at);
