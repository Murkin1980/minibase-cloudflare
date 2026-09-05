# MiniBase session notes

## 2026-09-05 — Iteration 38: MiniBase vNext CP-04 query + indexes

Decision unchanged: **EXTEND_EXISTING**. No new repository, backend, database,
ORM, or SQL API. CP-04 extends the one endpoint that needed it,
`GET /v1/data/{collection}`.

### Baseline before the change

`npm run check` PASS at `23cb091`: 177 tests across 26 files, bundle
71.44 KiB / gzip 14.89 KiB. List SQL was
`WHERE collection = ? AND id > ? ORDER BY id LIMIT ?`, cursor = the record ID,
one D1 REST round trip per page. Project schema latest version 4. Existing
`mb_records` indexes: PK `(collection, id)` and the documented-unused
`(collection, updated_at DESC)`.

### Evidence used to choose the allowlists

Only fields with a real consumer behind them were added. `docs/SCALABILITY.md`
items D/E ask for filtering on indexed fields plus explicit ordering;
`CODER_INSTRUCTION_1C_TUTOR_ONBOARDING.md` §8/§10 stores `schemaVersion` on every
document shape and resolves sync conflicts by `updatedAt`. That yields exactly
four filterable fields (`id`, `createdAt`, `updatedAt`, `schemaVersion`), three
orders, and four selectable response fields. Nothing was added speculatively —
an index without a query is waste, and a filter without an index is a scan
charged to the tenant.

### Implemented

1. **`src/record-query.ts`** — the whole query contract in one place: static
   allowlists of fields, operators, orders, and select names; per-field value
   validation; the statement builder; and the opaque cursor. No caller text ever
   becomes SQL, every value is bound, and there is no `OFFSET`.
2. **Keyset cursor per order** — `mbq1.<base64url>` carrying the sort value, the
   tie-breaker `id`, and a digest of collection + filters + order. A cursor from
   a different query is a deterministic 400, not a wrong page. A request with no
   `filter` and no `order` keeps the pre-CP-04 bare-record-ID cursor.
3. **Row-value keyset comparison** `(sort, id) > (?, ?)`, so a page boundary
   inside a run of equal timestamps can neither skip nor repeat a record, and
   SQLite can seek into the composite index instead of scanning.
4. **Project schema v5 — indexes only.** Three `CREATE INDEX IF NOT EXISTS` on
   `mb_records`, including an expression index over the fixed JSON path
   `$.schemaVersion`. No `ALTER TABLE`, no generated column, no row rewritten.
   A tenant still on v4 keeps serving every CP-04 query — same results, more
   rows scanned — which is why this rollout needs no coordination.
5. **SDK** — typed `filter` / `order` / `select` / opaque `after`, mirroring the
   server allowlists (asserted equal in `src/client.test.ts`). A pre-CP-04
   `list()` call serializes byte-identically.
6. **Docs** — `docs/DATA_API.md` §Query (full contract), `docs/DATA_MODEL.md`
   (v5 index table and rationale), `docs/MIGRATIONS.md` (why v5 is zero-risk and
   why it is still not applied anywhere), `docs/PROJECT_ISOLATION.md` §9,
   `docs/CLIENT_SDK.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `docs/SCALABILITY.md`.

### Verification

`npm run check` PASS: 218 tests across 28 files (177 baseline + 41 new), D1
integration, migration contract, release readiness, worker integration, and the
production dry-run build.

`src/query-index.test.ts` runs the exact emitted statements through real SQLite
(Miniflare) with the real schema applied and asserts on `EXPLAIN QUERY PLAN`:

```
?limit=10                              SEARCH … USING INDEX sqlite_autoindex_mb_records_1 (collection=?)
?limit=10&after=rec-0100               SEARCH … (collection=? AND id>?)
?order=createdAt.asc|desc              SEARCH … USING INDEX mb_records_collection_created_id_idx
?order=updatedAt.asc|desc              SEARCH … USING INDEX mb_records_collection_updated_id_idx
?filter[updatedAt.gte]=…&order=…       SEARCH … mb_records_collection_updated_id_idx (collection=? AND updated_at>?)
?filter[schemaVersion]=2               SEARCH … mb_records_collection_schema_version_id_idx (collection=? AND <expr>=?)
```

No plan contains a bare `SCAN mb_records` or a temp B-tree sort. The same file
upgrades a populated v4 database to v5 and asserts every row compares equal
before and after.

The cursor/query binding was mutation-tested: removing the digest check makes
exactly the intended test fail.

Bundle 71.44 KiB → 81.59 KiB (gzip 14.89 → 17.76 KiB), +10.15 KiB. That is the
query parser, the allowlists, the statement builder, and the cursor codec; the
SDK types are erased at build time. No dependency was added.

One query is still **one** D1 REST round trip — asserted directly.

### Deliberately not done

- No arbitrary SQL, SQL fragments, dynamic column names, joins, relation graph,
  full-text or fuzzy search, analytics, or `OFFSET`.
- No filtering on arbitrary JSON fields. A field is added only with a confirmed
  query and an index.
- The unused v1 `(collection, updated_at DESC)` index was **not** dropped.
  Removing an index is a separate change with its own justification.
- No CP-05 commands/transactions, no CP-06 files work.
- v5 was **not** applied to any remote or production D1. `interactive-kp` is
  untouched and stays on v4. Rolling v5 out is a separate operational step
  (`POST /v1/projects/{id}/schema/apply` per project), documented in
  `docs/MIGRATIONS.md`.

Deep change detected: **NO**. No Cloudflare resource, secret, production schema,
or deployment was touched.

## 2026-09-05 — Iteration 37: MiniBase vNext CP-03 project isolation

Decision for the MPE data platform remains **EXTEND_EXISTING**. Work stayed
strictly inside the canonical repository `Murkin1980/minibase-cloudflare`: one
Worker, one control D1, one shared R2 bucket, one D1 per project. No new
repository, database, or parallel backend was created.

Baseline before the change: `main` at
`5e3c63409cebd25b4e1dce534187d46e51c8430e`, CP-01 and CP-02 complete,
129 vitest tests across 25 files, Worker bundle 62.36 KiB (gzip 13.09 KiB).

### Objective and Problem

`docs/SCALABILITY.md` scoped CP-03 as "per-project quotas and per-route rate
periods". The read-only audit of the CP-02 code confirmed three concrete gaps
and one latent defect:

- **One rate-limit namespace for every route.** `abuse-control.ts` already
  partitioned keys into `control` / `data` / `files`, but all three consulted the
  same binding — production namespace 22001, 120 calls per 60 seconds. A browser
  polling `/v1/data` could therefore starve the control plane. This was listed in
  `docs/SECURITY.md` as an open production launch blocker.
- **No per-project request budget.** Limiting was by IP and by credential hash
  only. A project with many keys had no ceiling of its own, and one tenant could
  consume the account-wide D1 row quota every other tenant depends on —
  `docs/SCALABILITY.md` §3 risks 1 and 2.
- **No per-project ceilings.** CP-01 made every limit configurable per
  *deployment*. Nothing could be configured per *project*, so the smallest tenant
  and the largest shared one allowance.
- **Latent defect: both interpolated identities were unvalidated.**
  `projects.d1_database_id` is interpolated into the Cloudflare REST path and
  `projects.id` into the R2 key prefix. Neither is attacker-controlled — both come
  from the control plane — but neither was checked, so a hand-edited or corrupted
  control row could redirect the data plane to another API path or write an object
  outside its tenant prefix. Reproduced conceptually and closed rather than left
  as a theoretical risk.

### Implemented in CP-03

1. **Per-project quotas (`src/project-quotas.ts`, `migrations/0008_project_quotas.sql`)**
   - Four nullable `INTEGER` columns on `projects`, each with
     `CHECK (col IS NULL OR col > 0)`, no `NOT NULL`, no `DEFAULT`.
   - They live on `projects` rather than in a `project_quotas` table **on
     purpose**: the data-plane authentication query already joins `projects`, so a
     quota costs **zero** additional control-D1 statements on the hot path. A
     separate table would have added one read per authenticated request and
     re-created exactly the coupling CP-01 removed.
   - Tighten-only clamp, reusing CP-01's rule one level down:
     `HARD_LIMITS >= deployment ceiling >= project quota = enforced value`. An
     invalid stored value is ignored, so a row edited directly in the control D1
     can never widen a limit.
   - `keyActivityIntervalMs` is deliberately **not** a quota. It sizes the
     control-D1 write budget shared by every tenant, so a project raising it would
     raise the whole deployment's write volume — the CP-01 bug reintroduced. The
     management endpoint rejects it as an unknown field and `scripts/test-migrations.mjs`
     asserts the migration cannot add it.
   - Exceeding a quota returns a code consumers already handle: 413
     `request_body_too_large`, 413 `file_too_large`, 400 `invalid_limit`. No new
     error code, so no consumer error-handling change.

2. **Quota management API (`GET`/`PUT /v1/projects/{projectId}/quotas`)**
   - Scope `projects:write`, restricted to `status = 'active'`, mirroring every
     other project-scoped control-plane route.
   - `PUT` is a full replacement like `PUT .../origins`, so replaying a body is
     idempotent and an omitted field clears that quota.
   - The response separates `configured` (stored, `null` = inherit) from
     `effective` (actually enforced). Reporting both is deliberate: hiding the
     clamp would make a quota look applied when it is not.
   - Unknown fields are rejected with 400 `invalid_quota` rather than ignored, so
     a misspelled quota cannot look like it was applied.
   - Update and audit event go through `CONTROL_DB.batch()`, which is atomic, so
     a quota change is never visible without its audit trail
     (`project.quotas_replaced`, `entity = 'project'`, CP-01 `correlation_id`).

3. **Per-route rate periods (`src/abuse-control.ts`)**
   - Optional `RATE_LIMITER_CONTROL` / `RATE_LIMITER_DATA` / `RATE_LIMITER_FILES`.
     A Cloudflare binding carries its own `limit` and `period` and `limit()`
     accepts only a key, so per-route periods must be separate bindings — they
     cannot be arguments.
   - The pre-CP-03 shared `RATE_LIMITER` remains the fallback for every class, so
     an already-deployed Worker behaves exactly as before until the owner approves
     separate namespaces. No Cloudflare resource was created.

4. **Per-project rate buckets**
   - `{route}:project:{projectId}`, consulted after authentication and **before**
     the origin lookup — which is itself a control-D1 read — so an exhausted
     tenant stops spending control-plane capacity at that point.
   - Rate-limit denials write **no** audit row: a denial storm would otherwise
     spend the same daily write quota the limiter protects.

5. **Fail-closed project context (`src/security.ts`, `src/data-auth.ts`)**
   - `isSafeIdentity` requires `^[A-Za-z0-9-]{1,64}$`. Dots are excluded, so `..`
     cannot be expressed at all; `/ ? # %` and whitespace are excluded, so no path
     or query boundary can be injected. Canonical UUIDs always satisfy it.
   - Applied in `dataKeyDenialReason`, the single choke point every data-plane
     request passes through, so Records and Files are covered by one rule and a
     bad row is refused before any Cloudflare or R2 call.
   - Reuses the existing `project_unavailable` denial reason, so the response is
     the same 401 as every other project-context failure.
   - Opt-in `MB_RATE_LIMITER_REQUIRED="true"` makes a rate-limited route with no
     resolvable binding fail closed with 503 `rate_limiter_unavailable` instead of
     serving unlimited traffic. Off by default so local builds and tests are
     unaffected; 503 rather than 429 because the caller is not at fault.

6. **No project-existence leakage**
   - Unknown credential, suspended project, missing database, and corrupted
     database id all return an identical 401 `{"error":{"code":"unauthorized"}}`,
     and a new test asserts the four are indistinguishable while the audit log
     still records the distinguishing `metadata.reason`. Operators can diagnose;
     callers cannot enumerate.

7. **Tests (+48, 129 → 177 across 26 files)**
   - `src/project-quotas.test.ts`: inheritance, tightening, the widen-refusal, the
     hard maximum, fail-closed on malformed stored values, `keyActivityIntervalMs`
     exclusion, full-replacement semantics, unknown-field rejection.
   - `src/isolation.test.ts` (+13): malformed `d1_database_id` refused with no
     outbound D1 call; malformed `project_id` refused with no R2 object addressed;
     real UUIDs still accepted; identical denial across four project states; audit
     keeps the detail; per-project page/JSON/file quotas not affecting a neighbour;
     clamp above the deployment ceiling; exhausted project denied while a neighbour
     is served; separate bucket per project per route class; CP-01 cross-project
     isolation re-proven under the CP-03 limiter shape; fail-closed 503.
   - `src/abuse-control.test.ts` (+11): route classification, binding precedence
     and legacy fallback, only the governing binding consulted, one class denied
     without the others, health/preflight never gated, `MB_RATE_LIMITER_REQUIRED`
     semantics, per-project key shape and isolation.
   - `src/api-contract.test.ts` (+10): quota GET/PUT contract, idempotent replay,
     clearing by omission, enforcement on the very next data request, `effective`
     below `configured`, invalid bodies changing nothing, scope enforcement,
     `project_not_found` for missing and suspended projects, neighbour isolation,
     unsupported method.
   - `src/security.test.ts` (+3) and `src/data-auth.test.ts` (+2): the identity
     guard and the quota carried on the authenticated principal.
   - `scripts/test-d1.mjs`: **migration-without-data-loss proof.** Seeds a
     populated control database at 0007 — a live-shaped project, its key, its
     origin, its audit history — then applies 0008 and asserts every row survives
     unchanged with the new columns `NULL`, that the `CHECK` rejects 0 and -1, that
     a valid quota stores and clears, and that the columns are readable through the
     exact join the data plane uses.
   - `scripts/test-migrations.mjs`: 0008 must declare four checked nullable
     `INTEGER`s with no `NOT NULL`, no `DEFAULT`, and no key-activity column.
   - `src/test-harness.ts`: models the quota columns on both `projects` and the
     joined `api_keys` view, per-route bindings, recorded rate-limit consultations
     with the answering binding, and the `MB_RATE_LIMITER_REQUIRED` switch.
     `batch()` stays inert apart from the quota update, on purpose: executing every
     batched statement would start recording audit rows for provisioning, key, and
     origin mutations the harness previously dropped, changing assertions unrelated
     to CP-03.

8. **Documentation**
   - New `docs/PROJECT_ISOLATION.md`: the consumer contract — ten numbered
     guarantees with their mechanism and proof, how a project is identified, the
     fail-closed matrix, the quota model and its cost, the full quota API, the
     three rate-limit dimensions and what per-project rate limiting **cannot** do,
     a consumer checklist, and what is deliberately out of scope.
   - Updated `ARCHITECTURE.md`, `README.md`, `ROADMAP.md`, `docs/DATA_MODEL.md`,
     `docs/DATA_API.md`, `docs/SECURITY.md`, `docs/MIGRATIONS.md`,
     `docs/SCALABILITY.md`, and `wrangler.example.jsonc` (per-route bindings and
     the fail-closed switch, both commented out because creating a rate-limit
     namespace touches real Cloudflare resources).
   - Version 0.24.0 → 0.25.0.

### Deliberately not done

- **No per-project record-count or storage-byte quota.** Enforcing either needs a
  `COUNT` over the D1 REST hop per write, and ADR-0001 says round trips must be
  minimized rather than assumed cheap. Usage counters belong with CP-07 metrics.
- **No per-project numeric request rate.** A binding owns `limit` and `period`; a
  distinct number per project would need a MiniBase-maintained counter, i.e. a
  control-D1 write per request per project. Documented explicitly as a limitation
  rather than left implicit.
- **No project-scoped management keys** (`docs/SCALABILITY.md` item M, P3 — no IAM
  platform) and no row-level end-user authorization.
- **No project schema v5.** No project-database column was added, so the live
  `interactive-kp` tenant is unaffected and no coordinated `schema/apply` is
  needed. That remains CP-06.
- **No change to the D1 REST hop.** That is ADR-0001's "revisit when" condition, a
  deep change, and stays gated until CP-10 produces measurements.
- No CP-04, CP-05, or CP-06 work. No connection to `ai-microtask-factory`;
  persistent integration remains blocked behind CP-03/CP-05/CP-06, of which only
  CP-03 is now done.

### Verification

Commands run from the repository root on 2026-09-05, and their results:

| Command | Result |
| --- | --- |
| `npm install` (`npm ci`) | PASS — 188 packages |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS — **177 tests / 26 files** (baseline 129 / 25) |
| `npm run test:d1` | PASS — includes the 0007 → 0008 data-preservation proof |
| `npm run test:migrations` | PASS — 8 files, ordered 0001-0008, non-destructive, audit and quota contracts present |
| `npm run test:release` | PASS |
| `npm run test:worker` | PASS — against the built bundle |
| `npm run build` (`wrangler deploy --dry-run`) | PASS |
| `npm run check` (all of the above) | PASS |

Test count confirmed stable at 177 across three consecutive runs.

Bundle size: **62.36 KiB → 71.44 KiB** (gzip **13.09 KiB → 14.89 KiB**), i.e.
+9.08 KiB / +14.6% uncompressed and +1.80 KiB / +13.7% gzipped. The growth is
`src/project-quotas.ts` (5.3 KiB, new subsystem), the expanded abuse-control
dimension (+1.5 KiB), the quotas route and project-rate checks in `index.ts`
(+1.2 KiB), and the identity guard in `data-auth.ts` (+0.5 KiB). No new
dependency was added.

Migration result: **additive and non-destructive, verified on real SQLite.**
0008 was applied to a control database already holding a live-shaped project, its
API key, its origin allowlist entry, and its audit history; every row survived
unchanged and the four new columns read back `NULL`, i.e. "inherit the deployment
ceiling". No migration was applied to any real or remote database.

Secret scan: repeated and clean. No `mb_secret_*` / `mb_publishable_*` /
`mb_management_*` value in real format (prefix + 64 hex) exists in any tracked or
new file; every key literal CP-03 introduces is an obvious test double. No
Cloudflare API token, private key, or credential assignment was added.
`.dev.vars` and `wrangler.jsonc` remain untracked, and the new rate-limit
`namespace_id` values in `wrangler.example.jsonc` are commented-out
`REPLACE_WITH_*` placeholders.

`git diff --check`: clean, no whitespace errors.

Deep change detected: **NO**. CP-03 adds no component — it extends the rate
limiter that already existed, reuses the CP-01 ceiling clamp as its quota rule,
and puts four nullable columns on a table the authentication query already joins.

No production deploy. No Cloudflare resource, secret, remote database, or project
schema was created or changed. No connection to `ai-microtask-factory`. No
force-push and no merge into `main`.

GitHub Actions was not run: the owner's limit is exhausted, and `.github/` does
not exist in this repository. Local `npm run check` is the official quality gate,
per `docs/LOCAL_VALIDATION_POLICY.md`.

## 2026-09-04 — Iteration 36: MiniBase vNext CP-02 schema version authority

Decision for MPE data platform: **EXTEND_EXISTING**. Work strictly within the
existing MiniBase codebase, architecture, and single Worker / single control D1 /
per-project D1 setup.

### Objective and Problem

Previously, the project schema version had two potential sources of truth:
- `projects.data_schema_version` in the control D1;
- `mb_schema_versions` inside each project's D1 database.

`applyProjectSchema` planned migrations based on `projects.data_schema_version`
in the control D1, which could lead to silent drift and divergence if a migration
was interrupted or if control metadata was stale or out of sync.

### Implemented in CP-02

1. **Single Authoritative Source of Truth**:
   - `mb_schema_versions` in each project database is now the authoritative
     single source of truth for the actually applied schema version.
   - `projects.data_schema_version` in the control D1 is explicitly defined as a
     cache / last-observed version, updated when migrations are applied or synchronized.

2. **Project Schema Inspection and Verification**:
   - `inspectProjectSchema`: Directly queries `sqlite_master` and `mb_schema_versions`
     in the project's D1 database, checking for missing tables, gaps in applied versions,
     and unknown future versions.
   - `verifyProjectSchema` / `GET /v1/projects/{projectId}/schema/verify` (and `GET /schema`):
     Compares the project database's authoritative version against the control D1 cache,
     returning structured status (`ok`, `drift_detected`, `inconsistent`), applied versions,
     pending versions, and issue codes (`control_version_mismatch`, `missing_schema_versions_table`,
     `missing_version_gap`, `unknown_future_version`).

3. **Fail-Safe Schema Application**:
   - `applyProjectSchema` / `POST /v1/projects/{projectId}/schema/apply`:
     - Inspects authoritative schema state from the project DB.
     - Refuses to apply schema on inconsistent states (version gaps, unknown future versions,
       or missing version table when control DB version > 0) with HTTP 409 `inconsistent_schema_state`.
     - Genuinely new/unmigrated projects (missing version table with control DB version = 0)
       are safely bootstrapped to latest version.
     - Plans pending migrations using the authoritative project DB version.
     - Fully idempotent: repeated execution on up-to-date projects is safe and returns
       `{ previousVersion, version, applied: [] }`.
     - Synchronizes the control D1 cache after each migration and on no-op sync runs.
     - Preserves migration ordering and non-destructive forward-only semantics.
     - Audits `project.schema_applied` events with `entity = 'project'`, `entity_id = projectId`,
       and request `correlation_id`.

4. **Testing and Verification**:
   - Added unit and lifecycle tests in `src/project-schema.test.ts` for clean projects, older
     projects, missing version tables, version gaps, unknown future versions, repeated schema apply,
     control DB behind/ahead drift synchronization, and fail-safe rejection.
   - Added HTTP contract tests in `src/api-contract.test.ts` for management schema verification,
     shorthand route, apply flow, repeated apply idempotency, drift detection, inconsistent state
     rejection (409), and management authorization enforcement (401).

5. **Documentation**:
   - Updated `docs/MIGRATIONS.md`, `docs/DATA_MODEL.md`, `docs/DATA_API.md`,
     `docs/SCALABILITY.md`, `ROADMAP.md`, and `SESSION_NOTES.md`.

### Deliberately not done

- No project schema v5 introduced (remains v1..v4; schema v5 with file checksums/entity links deferred to CP-06).
- No new migration engine created.
- No destructive statements or schema rollback scripts.
- No modification of production resources, secrets, or remote databases.
- No deploy to Cloudflare (deployment remains a separate owner-approved action).

### Verification

`npm run check` passed: lint, typecheck, 128 vitest tests across 25 files, D1
integration, migration contract, release readiness, worker integration against
the bundle, and the production dry-run build.
Deep change detected: **NO**.

## 2026-09-03 — Iteration 35: MiniBase vNext CP-01 foundation hardening

Decision for the MPE data-platform upgrade: **EXTEND_EXISTING**. No new
repository, database engine, backend, or paid resource. A full read-only audit of
the code at `4b5b987` is recorded in `docs/SCALABILITY.md`, together with the
risk list, target architecture, gap matrix, and the CP-01…CP-10 plan.

### What the audit found

- The API was already versioned under `/v1`, so the planned "API versioning
  foundation" was a duplicate of something that exists. It was dropped.
- The Supabase migration library (`migration-manifest`, `-import`,
  `-verification`, `-rollback`, `postgres-sqlite`, `auth-migration`) is complete
  and tested but no HTTP route reaches it. It is library-only.
- `src/index.ts` routing had no test at all; the router was covered only by
  control-plane assertions in `scripts/test-worker.mjs`.
- `listRecords` and `listFiles` returned a non-null `nextAfter` on a short final
  page, so a consumer could not tell when enumeration ended. Reproduced before
  changing it: `limit=100` over a 2-record collection returned `nextAfter: "r2"`.
- Uploads stored the client-declared `Content-Length` as the file size rather
  than the bytes R2 actually received.
- `x-minibase-request-id` was returned to every caller but stored nowhere, so an
  audit event could not be tied back to the request that produced it.
- Measured by instrumenting the real handler: one authenticated data read cost
  three control-D1 statements (key read, `last_used_at` write, origin read) plus
  one outbound D1 REST call.

### Driving external change

Cloudflare began hard-enforcing D1 free-tier daily row limits on **2026-09-01**,
on both the Workers Binding API and the REST API. Because MiniBase wrote one
control-D1 row per authenticated data request, the whole deployment — all
projects together — was capped near the 100 000 row-write daily limit, and
unauthenticated traffic consumed the same quota through audit inserts. Key
activity is now written at most once per key per interval (default 5 minutes).
Revocation, expiry, project status, and scopes are still checked on every
request, so authorization is unchanged.

### Implemented in CP-01

- `src/limits.ts`: one source of truth for every request ceiling, overridable by
  Worker `vars`, with hard maxima. Invalid overrides fall back to the default
  rather than widening a limit.
- `src/pagination.ts`: shared keyset cursor parsing plus a `limit + 1` probe that
  yields `hasMore`. `nextAfter` semantics are unchanged, so existing consumers
  are unaffected.
- `src/idempotency.ts`: the provisioning `Idempotency-Key` behaviour extracted
  verbatim for reuse by future write commands. `provisioningFingerprint` was
  pinned by a test so the persisted `request_hash` values cannot drift.
- `migrations/0007_audit_contract.sql`: `entity`, `entity_id`, `correlation_id`
  on `audit_events`, plus indexes. `recordAudit` threads them, and the request ID
  already computed in `index.ts` now reaches the audit log.
- `src/files-api.ts`: measured upload size from the streamed body, `content-length`
  on download taken from the R2 object rather than possibly stale metadata, and
  `projectObjectKey` exported so isolation is directly testable.
- `src/test-harness.ts`: a double for the control D1, the D1 REST API, and R2 that
  lets tests drive the real `index.ts` handler. Used for new isolation,
  pagination, limit, idempotency, audit, control-plane cost, and consumer
  compatibility tests.
- `scripts/test-migrations.mjs`: control migration contract — ordered, unique,
  contiguous, non-destructive, no duplicated `ADD COLUMN`. Added to
  `npm run check`.

### Deliberately not done

- No project schema v5. A checksum or `uploaded_at` column would make the Worker
  write a column that the live `interactive-kp` tenant does not have until it runs
  `schema/apply`. That is deferred to CP-06 with a coordinated migration.
- No filtering, sorting, or field selection. No real consumer needs them yet, and
  adding them without an index story would create scans. Deferred to CP-04.
- No change to the D1 REST hop. That is ADR-0001's "revisit when" condition and
  would be a deep change; it stays gated until CP-10 produces measurements.

### Verification

`npm run check` passed: lint, typecheck, 104 vitest tests across 25 files, D1
integration, the new migration contract, release readiness, worker integration
against the built bundle, and the production dry-run build. Baseline before the
change was 61 tests across 19 files. Test count was confirmed stable across three
consecutive runs. Bundle 53.09 KiB -> 58.06 KiB (gzip 12.10 KiB).

Deep change detected: **NO**.

GitHub Actions was not run: the owner's limit is exhausted. Local `npm run check`
is the quality gate, per `docs/LOCAL_VALIDATION_POLICY.md`. No Cloudflare
resource, secret, schema, or deployment was touched, and no secret value was
written to the repository.


## 2026-08-25 — release-readiness portability fix

- Reproduced the release-readiness subprocess test failing only when a valid,
  gitignored production `wrangler.jsonc` exists in the checkout.
- Added an optional CLI config-path argument and made the blocked-path test pass
  an explicit missing fixture name.
- Production readiness behavior remains unchanged when no argument is supplied.

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

## 2026-07-30 — Iteration 28: numeric project slug regression fix

- Reproduced `invalid_slug` while onboarding the approved `1c-tutor-kz` project.
- Updated project and migration-manifest slug validation to allow an ASCII
  digit as the first character while retaining the existing length and
  character restrictions.
- Added a regression assertion for the exact `1c-tutor-kz` slug.
- Bumped the Worker health version to `0.22.2`.
- Full `npm run check` passed: lint, typecheck, 55 tests, D1 integration,
  release readiness, Worker integration, and build.

The change is limited to the proven onboarding contract defect. No project was
provisioned before the fixed Worker passed the complete local gate.

## 2026-07-30 — Iteration 29: browser SDK fetch binding

- Reproduced `TypeError: Illegal invocation` in a real Chrome onboarding e2e.
- Bound the default native `fetch` to `globalThis` while preserving injected
  fetch implementations used by tests and server consumers.
- Added a regression test that verifies the native fetch receiver.

This is a client SDK-only correction. It does not change the deployed Worker
runtime or its bindings.

## 2026-07-29 — Iteration 27: management key recovery and launch acceptance

- Revoked the lost initial owner management key.
- Issued a replacement and stored only its SHA-256 in control D1.
- Confirmed authenticated production audit access with the secret-safe smoke
  script.
- Verified health request ID `7800d8ee-53c2-49ec-ae06-1dedd89ff91c`.
- Verified audit request ID `6a601f54-fc06-4c3b-bca2-2cb63c18fc2f`.

MB8 and the MiniBase infrastructure project are accepted at 100%. Connecting
1C Tutor or another pilot remains a separately scoped onboarding iteration.

## 2026-08-20 — Iteration 30: publishable keys are read-only

- Restricted `mb_publishable_*` to `data:read` and `files:read`.
- Restricted all record/file writes and `project:admin` to backend-only
  `mb_secret_*` keys.
- Changed newly provisioned projects to issue a read-only initial publishable
  key and centralized the key-scope contract.
- Added regression coverage for rejected browser write scopes and documented
  the trust boundary.

MiniBase still has no end-user authentication or row-level authorization.
Browser writes must remain disabled until that capability is designed and
accepted separately. No project, Cloudflare resource, or deployment was
created or changed in this iteration.

## 2026-08-20 — Iteration 31: data-plane authentication audit

- Moved the shared audit writer into the audit module.
- Added denied `data.auth` events for missing, unknown, revoked, expired, scoped,
  inactive-project, and unavailable-project authentication failures.
- Store only the denial reason, required scope, and known key/project IDs; raw
  bearer values are never written to audit metadata.
- Kept successful authentication low-noise through the existing `last_used_at`
  update.
- Added focused tests for denial classification, safe audit payloads, and the
  no-success-audit boundary.

No production deployment or Cloudflare resource was changed.

## 2026-08-20 — Iteration 32: dual abuse-control ceilings

- Apply a route-scoped client-IP limit to every non-health request.
- Apply an additional SHA-256 bearer-identity limit when a credential exists.
- Prevent attackers from bypassing the shared ceiling by rotating arbitrary
  invalid bearer strings.
- Added regression coverage for IP sharing, distinct credential buckets, and
  raw-token exclusion.

The existing rate-limit binding is reused; no paid feature, production binding,
deployment, or Cloudflare resource was created or changed.

## 2026-08-20 — Iteration 33: identity schema foundation

- Added project schema v4 with native users, hash-only one-time activation,
  authoritative organization memberships, opaque sessions, and auth audit.
- Sessions include expiry, revocation reason, rotation lineage, auth version,
  and last-use fields; there is no password or provider-token column.
- Documented the dependency-free pilot activation flow and remaining runtime gates.
- Added regression coverage for ordering, lifecycle fields, membership keys,
  and forbidden credential storage.
- Made the release-readiness gate test portable: it now verifies the ready path
  against a committed fixture instead of relying on a local, gitignored
  `wrangler.jsonc`, and still asserts the CLI blocks (exit 2) when the real
  production config is absent.

No user was created, no token/session was issued, and no production schema,
deployment, paid feature, Supabase project, or Cloudflare resource was changed.

## 2026-08-25 — Iteration 34: Interactive KP onboarding

- Deployed MiniBase `0.23.0` to the existing `minibase-cloudflare` Worker;
  Cloudflare version ID: `6c5f014d-7028-4097-9896-832672890128`.
- Provisioned the `interactive-kp` tenant (project ID
  `58e27c56-0374-4a3f-84c5-90dca9bfcb3e`) on schema v4 with D1 database ID
  `22250945-ad19-44e4-a18f-9012983bd5f6` in EEUR.
- Allowed `https://kp.salamat-mebel.kz` and `http://localhost:3000` origins.
- Stored `MINIBASE_URL` and `MINIBASE_SECRET_KEY` as encrypted secrets on the
  existing `interactive-kp` Worker. No secret value was written to the repo.
- Revoked the one-time management key used for provisioning and verified the
  tenant, schema, origins, and revocation state from the control plane.
- Cloudflare Access policy creation remains pending because the current
  Wrangler OAuth grant has no Access Apps/Policies write permission.

Supabase remains only a temporary migration source for Interactive KP. The
accepted target runtime and system of record is MiniBase.
