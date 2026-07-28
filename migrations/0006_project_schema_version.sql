PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN data_schema_version INTEGER NOT NULL DEFAULT 0
  CHECK (data_schema_version >= 0);
