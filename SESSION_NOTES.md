# MiniBase session notes

## 2026-07-28 — Iteration 1: safe MB0/MB1 import

### Completed

- Imported the prepared Worker, control-plane D1 migration, tests, and documentation
  from the `1 C tutor/minibase` local scaffold without copying `node_modules`.
- Kept provisioning idempotency keyed by `Idempotency-Key`.
- Confirmed generated publishable and secret keys are persisted only as SHA-256
  hashes; the Cloudflare API token remains a Worker secret.
- Replaced direct management-key hash equality with a constant-time comparison.
- Added a Wrangler dry-run build and current Worker compatibility configuration.
- No Cloudflare Worker, D1 database, R2 bucket, or other production resource was
  created.

### Current boundary

This is an MB0/MB1 control-plane scaffold, not a production-ready BaaS. The
management key hash is still supplied as a Worker secret rather than managed as a
scoped record in D1.

### Required next iterations

1. Model `mb_management_*` keys in D1 with scopes, expiry, rotation, revocation,
   last-use metadata, and complete audit payloads.
2. Make provisioning resilient to partial failure and slug/idempotency races;
   define cleanup and retry behavior for remotely created D1 databases.
3. Add the per-project data-plane Worker contract and R2 file lifecycle.
4. Add a versioned Supabase migration format: manifest, JSON/NDJSON exports,
   PostgreSQL-to-SQLite transforms, auth handoff without password copying,
   checksums, verification reports, and rollback.
5. Decide whether realtime requirements justify Durable Objects; do not add them
   before that decision.

### Verification

Run `npm run check`. It executes lint, TypeScript checking, Vitest, and a Wrangler
dry-run build. GitHub Actions are intentionally not used.
