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
  "authoritativeVersion": 4,
  "cachedVersion": 4,
  "latestKnownVersion": 4,
  "appliedVersions": [1, 2, 3, 4],
  "pendingVersions": [],
  "issues": []
}
```

Status outcomes:
- `"ok"`: Project DB versions are contiguous and match control DB cache, or a genuinely unmigrated project (no table, control version = 0).
- `"drift_detected"`: Control DB cache differs from project DB authoritative version (when project DB has a valid version table).
- `"inconsistent"`: Project DB contains version gaps (e.g. `[1, 3]`), unknown future versions (e.g. `[1, 2, 3, 4, 5]`), or missing version table when control DB expected version > 0.

### Applying schema

```http
POST /v1/projects/{projectId}/schema/apply
Authorization: Bearer mb_management_...
```

Inspects the authoritative schema state in the project DB, applies only missing
versions in strict ascending order, updates `mb_schema_versions`, syncs the
control DB `data_schema_version` cache, and appends an audit event. Returns:

```json
{ "previousVersion": 1, "version": 4, "applied": [2, 3, 4] }
```

If the project is already at the latest schema version, it safely returns
`{ previousVersion: 4, version: 4, applied: [] }` and synchronizes the control
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

## Supabase migration packages

A separate, heavier format for moving an existing project in — manifest,
checksums, NDJSON tables, verification report, rollback plan. See
[`SUPABASE_MIGRATION.md`](SUPABASE_MIGRATION.md). That machinery is library-level
today: it is fully tested but no HTTP route executes it yet (CP-09).
