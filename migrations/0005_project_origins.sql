PRAGMA foreign_keys = ON;

CREATE TABLE project_origins (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, origin)
);

CREATE INDEX project_origins_origin_idx ON project_origins(origin);
