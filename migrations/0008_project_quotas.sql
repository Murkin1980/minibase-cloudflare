PRAGMA foreign_keys = ON;

-- CP-03 per-project quotas.
--
-- These columns live on `projects` on purpose. The data-plane authentication
-- query already joins `projects` to resolve the database UUID, so a quota read
-- costs zero extra control-D1 statements. A separate `project_quotas` table
-- would have added one read to every authenticated request, which is exactly
-- the coupling CP-01 removed (docs/SCALABILITY.md §3).
--
-- Every column is nullable and has no default: a project row written before
-- this migration reads back NULL, which means "inherit the deployment ceiling
-- resolved by src/limits.ts". Existing tenants keep byte-identical behaviour.
--
-- A stored value may only TIGHTEN the deployment ceiling, never widen it.
-- src/project-quotas.ts clamps every value and ignores anything that is not a
-- positive integer within the absolute hard maximum, so a hand-edited or
-- corrupted row fails closed instead of enlarging an unbounded request. The
-- CHECK constraints below are the first of those two layers.
--
-- `keyActivityIntervalMs` is deliberately NOT a per-project quota. It sizes the
-- control-D1 write budget shared by every tenant, so letting one project raise
-- it would reintroduce the account-wide ceiling CP-01 removed.

ALTER TABLE projects ADD COLUMN quota_max_json_bytes INTEGER
  CHECK (quota_max_json_bytes IS NULL OR quota_max_json_bytes > 0);
ALTER TABLE projects ADD COLUMN quota_max_file_bytes INTEGER
  CHECK (quota_max_file_bytes IS NULL OR quota_max_file_bytes > 0);
ALTER TABLE projects ADD COLUMN quota_max_page_size INTEGER
  CHECK (quota_max_page_size IS NULL OR quota_max_page_size > 0);
ALTER TABLE projects ADD COLUMN quota_max_bulk_records INTEGER
  CHECK (quota_max_bulk_records IS NULL OR quota_max_bulk_records > 0);
