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

## 2026-07-29 — Iteration 6: MB3 routing decision

### Completed

- Verified that ordinary D1 bindings are deployment-time capabilities.
- Rejected paid Workers for Platforms and a shared tenant database.
- Accepted a free-MVP data path using server-side D1 HTTP API calls after
  control-plane key authentication and project resolution.
- Documented security constraints and criteria for revisiting the decision in
  `docs/ADR-0001-data-plane-routing.md`.
- Added `ROADMAP.md` as the persistent visual progress source.

No production resource or paid service was created.

## 2026-07-29 — Iteration 7: authenticated records data plane

### Completed

- Added control-D1 metadata for data-key last use and rotation lineage.
- Added publishable/secret key authentication with project status, scope,
  expiry, and revocation enforcement.
- Added a server-only D1 HTTP client that derives database UUID from control D1.
- Added generic JSON records list/get/upsert/delete operations with parameterized
  SQL, bounded pagination, and strict collection/record ID validation.
- Added the `mb_records` schema to newly provisioned project databases.

### Boundary

This iteration is locally tested but does not call a real Cloudflare D1. CORS,
data-key management endpoints, and full Worker integration tests remain MB3 work.

## 2026-07-29 — Iteration 8: project-scoped browser origins

### Completed

- Added a normalized per-project origin allowlist in control D1.
- Added a scoped management endpoint that atomically replaces project origins
  and audits the change.
- Added data-plane origin enforcement after key authentication resolves the
  owning project.
- Added browser preflight handling and origin-specific response headers.
- Restricted non-TLS origins to localhost development.

Preflight responses expose no project data. A successful preflight does not
bypass authentication or the origin check on the actual request.

## 2026-07-29 — Iteration 9: project key lifecycle

### Completed

- Added management endpoints to list, issue, rotate, and revoke project keys.
- Enforced separate publishable and secret scope allowlists.
- Return raw key material only on successful creation; list responses omit both
  raw keys and hashes.
- Made rotation and revocation atomic with their audit records.
- Prevented rotation across projects or key kinds.

No existing project key is revoked until its replacement and audit record can be
committed in the same D1 batch.

## 2026-07-29 — Iteration 10: versioned project schema

### Completed

- Replaced inline provisioning DDL with an ordered project-schema registry.
- Track each active project's applied data-schema version in control D1.
- Added an idempotent management endpoint to apply only missing schema versions.
- New project provisioning and later upgrades use the same schema source.
- Added ordering, idempotency, and destructive-statement guard tests.

Remote D1 schema calls are not claimed as production-verified. Every current
statement is idempotent so interrupted upgrades can be safely requested again.

## 2026-07-29 — Iteration 11: MB3 Worker acceptance

### Completed

- Added a Miniflare/workerd test for the actual bundled Worker.
- Apply all control migrations before each isolated integration run.
- Verified health, unauthorized management access, scoped project-key issuance,
  omission of raw/hash data from key listings, scope denial, and CORS preflight.
- Added Worker integration acceptance to the mandatory `npm run check` gate.

### MB3 verdict

MB3 is complete for local acceptance. The only intentionally unverified boundary
is the outbound Cloudflare D1 HTTP call against a real account/database. Testing
that boundary would require production-like resources and owner approval.

## 2026-07-29 — Iteration 12: R2 streaming file API

### Completed

- Added a static R2 binding template; no bucket was created.
- Added project schema v2 with `mb_files` metadata.
- Added streaming file upload/download, metadata list, and deletion endpoints.
- Isolated every R2 key with an authenticated project-ID prefix.
- Added `files:read` and `files:write` key scopes.
- Require a declared upload length and cap the MVP upload at 25 MiB.
- Delete a newly uploaded R2 object if metadata persistence fails.

### Boundary

R2 object bytes are never buffered by Worker code. Remote project-D1 metadata
calls remain locally mocked at their outbound boundary.

## 2026-07-29 — Iteration 13: MB4 acceptance and reconciliation

### Completed

- Added integration-boundary tests proving project-prefixed R2 writes.
- Verified upload bodies remain streams and metadata failure triggers R2 delete.
- Added read-only file reconciliation for orphaned and missing objects.
- Limited each reconciliation report to 1000 metadata rows and objects and
  exposes a truncation flag.

### MB4 verdict

MB4 is complete for local acceptance. Reconciliation is deliberately report-only;
no automatic deletion policy is assumed.

## 2026-07-29 — Iteration 14: migration package contract

### Completed

- Added a versioned Supabase migration manifest JSON Schema and runtime validator.
- Require SHA-256, byte size, unique safe path, and optional row count for every
  package file.
- Standardized table exports on UTF-8 NDJSON.
- Added a streaming offline checksum CLI.
- Explicitly allow only password-reset or dual-auth handoff strategies.
- Explicitly forbid copying Supabase password hashes, sessions, refresh tokens,
  service-role keys, database passwords, and JWT secrets.

No Supabase project was connected or modified.

## 2026-07-29 — Iteration 15: PostgreSQL to SQLite transform

### Completed

- Added strict declarative Postgres table/column input contracts.
- Added deterministic SQLite type, default, and value transforms.
- Quote allowlisted identifiers and reject unsafe names.
- Convert booleans, JSON/JSONB, arrays, bytea, and temporal values without
  evaluating source content.
- Emit precision/default warnings and reject unsupported types.

Raw PostgreSQL dumps, functions, triggers, policies, and extensions are not
executed as SQLite.

## 2026-07-29 — Iteration 16: safe Supabase Auth identity export

### Completed

- Added an allowlist-only `auth.users` sanitizer.
- Normalize verified email/phone contacts and timestamps.
- Recursively detect credential, token, session, OTP, nonce, and secret fields.
- Exclude both user and app metadata from automatic authorization migration.
- Mark every identity as requiring password reset or fresh dual-auth handoff.

No Supabase password hash or active credential is accepted as migration proof.

## 2026-07-29 — Iteration 17: verified offline table import

### Completed

- Verify source bytes, SHA-256, declared NDJSON rows, and exact row shape.
- Transform values according to the reviewed PostgreSQL catalog.
- Build parameter-bound staging/upsert batches without executing source SQL.
- Add project schema v3 migration journal keyed by migration ID and file path.
- Skip exact completed replays and reject checksum or row-count conflicts.

This iteration builds and tests offline import batches only. It does not connect
to Supabase or execute against a production D1 database.

## 2026-07-29 — Iteration 18: migration verification and rollback evidence

### Completed

- Build a deterministic per-file verification report.
- Fail on missing, duplicate, unexpected, or mismatched migration evidence.
- Require a verified report, D1 bookmark, and checksummed R2 backup manifest
  before constructing a rollback plan.
- Fix the recovery sequence from write freeze through post-restore verification.

MB5 is locally accepted. No backup, migration, restore, production resource, or
paid service was created or invoked.

## 2026-07-29 — Iteration 19: typed records client

### Completed

- Added a zero-dependency TypeScript client for list/get/put/delete records.
- Validate HTTPS base URLs, collections, IDs, pagination, and record objects.
- Normalize JSON API failures into typed client errors.
- Permit publishable and secret data keys while explicitly rejecting management
  keys from the application SDK.

The client was tested only with mocked fetch; no Worker deployment was created.

## 2026-07-29 — Iteration 20: file client and MB6 acceptance

- Added list, streaming download, Blob upload, and delete file helpers.
- Preserve upload content type and explicit byte length.
- Apply the Worker-compatible traversal-safe path contract in the client.

MB6 is locally accepted; package registry publication remains out of scope.

## 2026-07-29 — Iteration 21: uniform HTTP hardening

- Added correlation IDs with strict validation and generated fallback UUIDs.
- Added CSP, frame, MIME sniffing, referrer, permissions, and no-store defaults
  to every Worker response.
- Preserved streaming response bodies and existing stricter cache directives.
- Added a top-level sanitized fallback for otherwise uncaught exceptions.

No rate-limit binding or production configuration was created.

## 2026-07-29 — Iteration 22: abuse-control contract and MB7 acceptance

- Added optional Worker Rate Limiting binding support.
- Partition limits by control/data/files and hash bearer credentials.
- Bypass health and CORS preflight; return stable `rate_limited` HTTP 429.
- Documented the explicit production approval gate.

No binding, rule, deployment, or paid resource was created.

## 2026-07-29 — Iteration 23: launch-readiness package

- Added an owner production-decision template.
- Added ordered launch, abort, and rollback runbook.
- Added a local machine-readable readiness gate.
- Added acceptance coverage proving launch stays blocked without `wrangler.jsonc`.

MB8 remains intentionally incomplete pending explicit production approval.

## 2026-07-29 — Iteration 24: Windows readiness CLI correction

- Corrected direct-entry detection with canonical Windows file URLs.
- Added a subprocess acceptance test for JSON output and blocked exit code 2.

## 2026-07-29 — Iteration 25: production infrastructure and public smoke

### Created

- Control D1 `minibase-control` in EEUR.
- R2 Standard bucket `minibase-files`.
- Worker `minibase-cloudflare` with rate-limit namespace 22001.

### Verified

- Applied control migrations 0001 through 0006.
- Deployed version `bf880f05-28a7-4038-a592-3dc9bbb5738c`.
- Health returned 200/version 0.22.1.
- CSP, frame denial, no-store, and correlation ID headers were present.
- An unauthenticated data request returned 401.
- Issued the initial management key and stored only its SHA-256.

### Remaining

`CLOUDFLARE_D1_API_TOKEN` is not configured. Authenticated management smoke and
pilot-project provisioning remain blocked until a narrowly scoped token is
created and stored interactively. No paid plan or paid-only feature was enabled.

The static readiness gate now reports ready because an approved, placeholder-free
local production config exists. Runtime secret and pilot gates remain separate.

## 2026-07-29 — Iteration 26: production D1 token and safe management smoke

- Confirmed `CLOUDFLARE_D1_API_TOKEN` exists as a secret-text Worker secret.
- Confirmed Cloudflare deployed secret-change version
  `fca611d0-e24c-4315-a5b6-1ca7c6c33a20`.
- Repeated health, security-header, and unauthenticated management smoke.
- Added a read-only authenticated smoke script that accepts the management key
  only through environment state and never prints it.

Authenticated smoke awaits a trusted local key entry. Pilot project creation is
not inferred from infrastructure approval.

## 2026-07-29 — Iteration 27: management key recovery and launch acceptance

- Revoked the lost initial owner management key.
- Issued a replacement and stored only its SHA-256 in control D1.
- Confirmed authenticated production audit access with the secret-safe smoke
  script.
- Verified health request ID `7800d8ee-53c2-49ec-ae06-1dedd89ff91c`.
- Verified audit request ID `6a601f54-fc06-4c3b-bca2-2cb63c18fc2f`.

MB8 and the MiniBase infrastructure project are accepted at 100%. Connecting
1C Tutor or another pilot remains a separately scoped onboarding iteration.
