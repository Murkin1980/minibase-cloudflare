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

## 2026-07-28 — Iteration 2: D1-backed management keys

### Completed

- Added migration `0002_management_keys.sql` with hashed management keys,
  scopes, expiry, revocation, rotation linkage, and last-use timestamps.
- Replaced the single Worker-secret management hash with D1 lookup.
- Added scoped authentication and denied-auth audit records.
- Added issue/rotate and revoke management-key endpoints.
- Added an offline bootstrap-key generator that emits a one-time key and SQL
  containing only its SHA-256 hash.
- Linked successful project provisioning audit events to the acting management
  key.

### Safety boundary

- Raw management keys are returned or printed once and are never persisted.
- The Cloudflare API token remains a Worker secret and is never returned.
- Bootstrap generation is offline; no D1, R2, Worker, or paid resource is
  created by it.

### Remaining MB2 work

- Add audit-log read API and integration-level D1 tests.
- Make remote D1 provisioning and key rotation resilient to partial failures and
  concurrent requests.
- Add explicit API error taxonomy and bounded request-body handling.
