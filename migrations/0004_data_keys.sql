PRAGMA foreign_keys = ON;

ALTER TABLE api_keys ADD COLUMN name TEXT;
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
ALTER TABLE api_keys ADD COLUMN rotated_from_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL;

CREATE INDEX api_keys_active_lookup_idx
  ON api_keys(key_hash, revoked_at, expires_at);
