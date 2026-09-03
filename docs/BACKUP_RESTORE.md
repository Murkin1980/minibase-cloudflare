# Backup and restore

Free-tier only. No paid backup service is connected, and none should be until a
measured requirement exists.

Every command below was checked against the Wrangler version pinned in
`package.json` (4.114.0). Nothing here creates a paid resource.

## What has to be recoverable

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Control D1 `minibase-control` | one D1 database | projects, key hashes, provisioning jobs, audit events, browser origins. Losing it loses the ability to route or authenticate **any** project. |
| Project D1s `mb-<slug>` | one D1 per project | the project's records, file metadata, and auth tables. Losing one loses one tenant, not the platform. |
| R2 bucket `minibase-files` | one shared bucket, keys `{projectId}/{path}` | uploaded originals. Not reconstructible from D1. |
| Worker code and config | this repository plus `wrangler.jsonc` (gitignored) | `wrangler.jsonc` holds the real database IDs and is deliberately **not** in Git. |

The control D1 is the highest-value asset: it is small, it is shared, and it is
the only one whose loss takes down every tenant at once.

## D1 backup

`wrangler d1 export` writes a `.sql` file. It needs `--remote` to read production
and `--output` is required.

```bash
# Control plane — back this up before anything else.
npx wrangler d1 export minibase-control --remote \
  --output "backups/minibase-control-$(date -u +%Y%m%dT%H%M%SZ).sql"

# Every project database. `mb-<slug>` is the naming convention provision.ts uses.
for db in $(npx wrangler d1 list --json | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    for (const db of JSON.parse(s)) if (db.name.startsWith("mb-")) console.log(db.name);
  });'); do
  npx wrangler d1 export "$db" --remote --output "backups/${db}-$(date -u +%Y%m%dT%H%M%SZ).sql"
done
```

Record the SHA-256 of every export. `npm run migration:checksum` already does
this and is the same tooling the Supabase path uses:

```bash
npm run migration:checksum -- backups/minibase-control-2026-09-03T00:00:00Z.sql
```

Keep exports **out of Git**. `backups/` is not committed; store them in the
owner's trusted location. An export of the control D1 contains key hashes — not
raw keys — but it is still sensitive.

## D1 restore

Restoring is a destructive operation on the target database. Do it inside an
approved window, and take a fresh export of the current state first so the
restore itself is reversible.

```bash
# 1. Freeze writes. Revoke the data keys for the affected project, or set the
#    project's status away from 'active' so authenticateDataKey refuses it.

# 2. Snapshot the state you are about to replace.
npx wrangler d1 export minibase-control --remote --output backups/pre-restore-control.sql

# 3. Restore into a scratch database and verify before touching production.
npx wrangler d1 create minibase-control-restore-check
npx wrangler d1 execute minibase-control-restore-check --remote \
  --file backups/minibase-control-2026-09-03T00:00:00Z.sql

# 4. Verify row counts and the audit trail against expectations.
npx wrangler d1 execute minibase-control-restore-check --remote \
  --command "SELECT (SELECT COUNT(*) FROM projects) AS projects,
                    (SELECT COUNT(*) FROM api_keys) AS keys,
                    (SELECT COUNT(*) FROM audit_events) AS audit"

# 5. Only after verification, restore production.
npx wrangler d1 execute minibase-control --remote \
  --file backups/minibase-control-2026-09-03T00:00:00Z.sql

# 6. Drop the scratch database and re-enable writes.
npx wrangler d1 delete minibase-control-restore-check
```

Restoring the control D1 does **not** restore `projects.d1_database_id`
mismatches caused by a project database being recreated. After a control-plane
restore, confirm each `d1_database_id` still exists:

```bash
npx wrangler d1 list
```

## Time travel

`wrangler d1 time-travel` can restore or copy a database to an earlier point
without an export file:

```bash
npx wrangler d1 time-travel info minibase-control --timestamp 2026-09-03T09:00:00Z
npx wrangler d1 time-travel restore minibase-control --timestamp 2026-09-03T09:00:00Z
```

Treat Time Travel as a convenience, **not** as the backup. Confirm the retention
window that applies to the current plan with `time-travel info` before depending
on it, and keep the scheduled `d1 export` as the plan-independent guarantee.

## R2 backup

The bucket is shared, so a backup must stay per project. R2 object metadata
lives in each project's `mb_files` table, so D1 exports and R2 objects must be
taken close together or the two will disagree.

1. Export every project D1 first (above).
2. Copy the objects. Free path, using the Wrangler-authenticated API and the
   `r2 object get` / `r2 object put` commands, per project prefix:

```bash
npx wrangler r2 object get "minibase-files/<projectId>/<path>" ./backup/<projectId>/<path>
```

3. Record a manifest of `{key, size, etag}` and its SHA-256 — the same shape
   `migration-manifest.schema.json` already defines.

`GET /v1/projects/{projectId}/files/reconcile` compares up to 1000 metadata rows
against R2 objects and reports orphaned objects and missing objects. Run it
after a restore; it never deletes anything.

## Verification

A backup that has not been restored is a hypothesis. At minimum:

1. every export has a recorded SHA-256 and byte count;
2. a scheduled restore into a **scratch** database succeeds and its row counts
   match the source;
3. `files/reconcile` reports no orphans after a file restore;
4. `/health` and an authenticated `GET /v1/audit-events?limit=1` pass after a
   control-plane restore — this is exactly what `npm run smoke:production`
   checks.

## What is deliberately not done in Phase 1

- No paid backup service, no external object store, no off-cloud copy target.
- No automated schedule. Scheduling requires a Cron Trigger and an approved
  storage target; that is CP-08, after CP-01 lands.
- No point-in-time replication of R2. Reconciliation plus manifest checksums is
  the accepted consistency control for now.

## Relationship to Supabase migration rollback

`src/migration-rollback.ts` already fixes a five-step order for rolling back a
*Supabase import*: disable target writes, restore the D1 bookmark, restore R2
from the checksummed manifest, re-verify the source manifest, re-enable writes.
That plan is specific to migration windows. This document covers ordinary
operation and uses the same primitives.
