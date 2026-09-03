PRAGMA foreign_keys = ON;

ALTER TABLE audit_events ADD COLUMN entity TEXT;
ALTER TABLE audit_events ADD COLUMN entity_id TEXT;
ALTER TABLE audit_events ADD COLUMN correlation_id TEXT;

CREATE INDEX audit_events_correlation_idx ON audit_events(correlation_id);
CREATE INDEX audit_events_entity_created_idx ON audit_events(entity, entity_id, created_at);
