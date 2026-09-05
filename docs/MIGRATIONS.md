# Schema migrations

Two independent mechanisms, because there are two kinds of database.

## Control D1

Numbered SQL files in `migrations/`, applied by Wrangler in filename order and
recorded in Wrangler's `d1_migrations` table.

```
migrations/0001_control_plane.sql
migrations/0002_management_keys.sql
...
migrations/0007_audit_contract.sql
migrations/0008_project_quotas.sql
```

```bash
npx wrangler d1 migrations apply minibase-control --remote
```

Rules, enforced by `npm run test:migrations`:

- filenames match `NNNN_name.sql`; numbering is unique, ordered, and contiguous
  from `0001`;
- every file starts with `PRAGMA foreign_keys = ON;`;
- **no file contains `DROP`, `TRUNCATE`, or `DELETE FROM`** — control migrations
  are forward-only and non-destructive;
- no column is added twice across files (`ALTER TABLE … ADD COLUMN` fails if the
  column exists).

`0008` adds the CP-03 per-project quota columns. It is the model for an additive
control migration on a database that already holds tenants: four nullable
`INTEGER` columns, each with `CHECK (col IS NULL OR col > 0)`, no `NOT NULL` and
no `DEFAULT`. A row written before the migration therefore reads back `NULL`,
which means "inherit the deployment ceiling", and an existing tenant's behaviour
is unchanged. `scripts/test-d1.mjs` proves this by seeding a populated control
database at `0007`, applying `0008`, and asserting that the project, its key, its
origin, and its audit history all survive with the new columns `NULL`.

An applied migration is immutable. To change something, add the next file.

Rollback is **not** provided by downgrade scripts. The control plane is restored
from a verified export — see [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md). This is a
deliberate forward-only policy: a control-plane downgrade would have to reason
about key hashes and audit history that must never be silently rewritten.

## Project D1

Declared in code in `src/project-schema.ts` as `projectSchemaMigrations`, each
version a list of statements. Every statement is idempotent
(`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`), so a version that was
interrupted can be re-run safely.

### Single source of truth

`mb_schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
inside each project database is the **authoritative source of truth** for the
applied schema version.

`projects.data_schema_version` in the control D1 is explicitly a **cached /
last-observed version**, not an independent authority. When migrations are
planned or applied, MiniBase queries the project database's `mb_schema_versions`
table directly.

### Verification endpoint

```http
GET /v1/projects/{projectId}/schema/verify
Authorization: Bearer mb_management_...
```

Inspects the project's own database and compares it against the control-plane
cache. Returns:

```json
{
  "projectId": "11111111-1111-4111-8111-111111111111",
  "status": "ok",
  "authoritativeVersion": 5,
  "cachedVersion": 5,
  "latestKnownVersion": 5,
  "appliedVersions": [1, 2, 3, 4, 5],
  "pendingVersions": [],
  "issues": []
}
```

Status outcomes:
- `"ok"`: Project DB versions are contiguous and match control DB cache, or a genuinely unmigrated project (no table, control version = 0).
- `"drift_detected"`: Control DB cache differs from project DB authoritative version (when project DB has a valid version table).
- `"inconsistent"`: Project DB contains version gaps (e.g. `[1, 3]`), unknown future versions (e.g. a version beyond `latestKnownVersion`), or missing version table when control DB expected version > 0.

### Applying schema

```http
POST /v1/projects/{projectId}/schema/apply
Authorization: Bearer mb_management_...
```

Inspects the authoritative schema state in the project DB, applies only missing
versions in strict ascending order, updates `mb_schema_versions`, syncs the
control DB `data_schema_version` cache, and appends an audit event. Returns:

```json
{ "previousVersion": 1, "version": 5, "applied": [2, 3, 4, 5] }
```

If the project is already at the latest schema version, it safely returns
`{ previousVersion: 5, version: 5, applied: [] }` and synchronizes the control
cache if it was stale.

If an inconsistent state is detected (e.g., missing version gaps or future
unknown versions), the endpoint fails safe with HTTP 409
`{"error": {"code": "inconsistent_schema_state"}}` rather than attempting
silent resolution or partial execution.

Rules, enforced by `src/project-schema.test.ts`:

- versions are strictly ordered, contiguous, and unique;
- only missing versions are planned, and planning is idempotent at the current
  version;
- no version contains `DROP` or `TRUNCATE`.

### Adding a version

1. Append a new entry to `projectSchemaMigrations` with the next version number.
2. Use `IF NOT EXISTS` / `OR IGNORE` on every statement.
3. For a new column on an existing table, make it nullable or defaulted — an
   existing tenant must keep working before it runs `schema/apply`.
4. Update `src/project-schema.test.ts` expectations.
5. Run `npm run check`.
6. Apply per project through the endpoint, and verify with `/schema/verify`.

Provisioning applies every version to a brand-new database automatically
(`provision.ts` flattens `projectSchemaMigrations`), so a new project is always
at the latest version while an existing one stays where it was until `schema/apply`
runs. **This asymmetry is intentional** and is the reason a new column must never
be required by the Worker before every live project has been migrated.

### Project schema v5 (CP-04 query indexes)

v5 is the model for a **zero-risk** project migration: three
`CREATE INDEX IF NOT EXISTS` statements on `mb_records` and the version record.
There is no `ALTER TABLE`, no generated column, no `NOT NULL`, and no row is
read or rewritten, so a populated project database upgrades as a pure metadata
operation and every existing record is preserved byte for byte. Replaying v5 is
a no-op.

Because v5 adds no column, the Worker never depends on it for correctness: a
tenant still on v4 keeps serving every CP-04 query, just without the index —
same results, more rows scanned. That is what makes the rollout uncoordinated
and safe, unlike the CP-06 v5-style change that was deferred precisely because
it would have added a column.

`src/query-index.test.ts` proves both halves against real SQLite: a v4 database
holding documents is upgraded to v5 and every row compares equal before and
after, and each supported query's `EXPLAIN QUERY PLAN` names the index it is
supposed to use.

**Not applied to any remote or production D1 by this checkpoint.** Rolling v5
out to a live tenant — including `interactive-kp` — is an explicit, separate
operational step: run `POST /v1/projects/{projectId}/schema/apply` per project
and confirm with `/schema/verify`. Until then those tenants stay on v4 and
continue to work.

## Supabase migration packages

A separate, heavier format for moving an existing project in — manifest,
checksums, NDJSON tables, verification report, rollback plan. See
[`SUPABASE_MIGRATION.md`](SUPABASE_MIGRATION.md). That machinery is library-level
today: it is fully tested but no HTTP route executes it yet (CP-09).
