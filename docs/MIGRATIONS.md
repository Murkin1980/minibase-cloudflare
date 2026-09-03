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

```http
POST /v1/projects/{projectId}/schema/apply
Authorization: Bearer mb_management_...
```

Applies only versions above the project's current one, in order, and records the
result in the control-plane audit log. Returns:

```json
{ "previousVersion": 1, "version": 4, "applied": [2, 3, 4] }
```

Rules, enforced by `src/project-schema.test.ts`:

- versions are strictly ordered and unique;
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
6. Apply per project through the endpoint, and verify.

Provisioning applies every version to a brand-new database automatically
(`provision.ts` flattens `projectSchemaMigrations`), so a new project is always
at the latest version while an existing one stays where it was until `schema/apply`
runs. **This asymmetry is intentional** and is the reason a new column must never
be required by the Worker before every live project has been migrated.

### Version bookkeeping

`projects.data_schema_version` (control D1) drives planning. `mb_schema_versions`
(project D1) records what the project actually has. CP-02 makes the project's own
table authoritative and adds a verification step, because the two can currently
diverge if a migration is interrupted between the last statement and the control
update.

## Supabase migration packages

A separate, heavier format for moving an existing project in — manifest,
checksums, NDJSON tables, verification report, rollback plan. See
[`SUPABASE_MIGRATION.md`](SUPABASE_MIGRATION.md). That machinery is library-level
today: it is fully tested but no HTTP route executes it yet (CP-09).
