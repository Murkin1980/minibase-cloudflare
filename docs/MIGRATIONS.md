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
  "authoritativeVersion": 6,
  "cachedVersion": 6,
  "latestKnownVersion": 6,
  "appliedVersions": [1, 2, 3, 4, 5, 6],
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
{ "previousVersion": 1, "version": 6, "applied": [2, 3, 4, 5, 6] }
```

If the project is already at the latest schema version, it safely returns
`{ previousVersion: 6, version: 6, applied: [] }` and synchronizes the control
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
and safe, unlike a future coordinated schema change that would add a column.

`src/query-index.test.ts` proves both halves against real SQLite: a v4 database
holding documents is upgraded to v5 and every row compares equal before and
after, and each supported query's `EXPLAIN QUERY PLAN` names the index it is
supposed to use.

### Project schema v6 (CP-05 atomic command marker)

v6 is forward-only and additive: it creates `mb_commands` and the one static
`mb_commands_records_upsert_many_apply` trigger, then records version 6 in the
project database's authoritative `mb_schema_versions` table. It neither alters
nor rewrites `mb_records`; the trigger is dormant until a fresh CP-05 command
marker is inserted. Replaying each `CREATE … IF NOT EXISTS` / `INSERT OR IGNORE`
statement is safe.

The marker stores only the SHA-256 hash of `Idempotency-Key`, never the raw key.
Its unique `(command_type, idempotency_key_hash)` constraint is scoped naturally
to the project database. Its static trigger validates fixed JSON paths and
applies all records in the same SQLite statement as the marker. A partially
installed v6 cannot serve a command: the one command statement requires both
v6's authoritative version row and the exact trigger before it can insert.

`src/commands.integration.test.ts` seeds a populated v5 D1 database, applies v6
twice, and proves pre-existing records remain byte-for-byte unchanged while the
version record and trigger are installed. The same real-Miniflare suite proves
one-statement execute/replay/conflict behavior, concurrent winners, and rollback
on a trigger failure after the first target would otherwise be processed.

**No remote or production project schema was applied by CP-05.** Upgrading a
live project—including `interactive-kp`—is an explicit owner-approved operating
step: first inspect `GET /v1/projects/{projectId}/schema/verify`, then run
`POST /v1/projects/{projectId}/schema/apply`, then verify again. Until that step,
a v5 project continues serving legacy record routes but CP-05 commands fail
closed with `command_schema_not_ready` (or generic `cloudflare_api_error` where
the absent table cannot safely be distinguished). The Worker never performs this
remote upgrade on a command request and never falls back to legacy PUT writes.

## Supabase migration packages

A separate, heavier format for moving an existing project in — manifest,
checksums, NDJSON tables, verification report, rollback plan. See
[`SUPABASE_MIGRATION.md`](SUPABASE_MIGRATION.md). That machinery is library-level
today: it is fully tested but no HTTP route executes it yet (CP-09).
