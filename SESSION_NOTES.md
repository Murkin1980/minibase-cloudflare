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

- Add integration-level D1 tests and explicit API error taxonomy.

## 2026-07-28 — Iteration 3: audit API and HTTP boundaries

### Completed

- Added `GET /v1/audit-events` guarded by `audit:read`.
- Added bounded cursor-style audit pagination with a maximum page size of 100.
- Added streaming, size-enforced JSON request parsing with a 64 KiB default.
- Rejected missing or incorrect JSON content types and malformed JSON with stable
  machine-readable error codes.
- Added tests for body limits, content type, and audit query validation.

### Safety boundary

Audit responses contain key IDs and metadata but never key hashes, raw keys, or
Cloudflare credentials. No remote resource was created.

## 2026-07-28 — Iteration 4: atomic control-plane mutations

### Completed

- Added atomic D1 batches for project/job reservation, provisioning completion,
  management-key issue/rotation, and revocation.
- Bound each idempotency key to a canonical request hash and reject mismatched
  replays.
- Re-read the winning provisioning job after an idempotency race.
- Persist the remote D1 identifier as soon as it is created.
- Added compensating D1 deletion after partial provisioning failure and persist
  whether rollback completed or failed.
- Added failure audit records without leaking error payloads or credentials.

### Known boundary

Automatic retry of a failed provisioning job remains disabled. A failed rollback
may leave a remote D1 ID recorded for operator reconciliation; the control plane
will not silently create a duplicate database.

## 2026-07-28 — Iteration 5: MB2 acceptance

### Completed

- Added a stable `{ error: { code } }` response envelope and HTTP status mapping.
- Sanitized unknown and Cloudflare API failures so upstream details are not
  returned to callers.
- Replaced locale-dependent validation messages with machine-readable codes.
- Added a Miniflare/workerd D1 integration test that applies every migration,
  exercises management-key persistence and revocation, verifies recovery
  columns, and proves failed D1 batches roll back atomically.
- Added the D1 integration test to the mandatory `npm run check` gate.

### MB2 verdict

MB2 control plane is complete for local acceptance. Production provisioning is
still intentionally unverified because no production Worker or Cloudflare
resource has been approved or created.
