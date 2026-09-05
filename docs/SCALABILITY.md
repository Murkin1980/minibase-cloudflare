# MiniBase scalability audit

Decision: **EXTEND_EXISTING**. MiniBase stays one Worker, one control D1, one
shared R2 bucket, and one D1 per project. No new repository, database engine, or
backend.

Audit date: 2026-09-03. Every claim below was read from the code at commit
`4b5b987` or measured by running it, not taken from the README.

---

## 1. Current architecture (as built)

```text
                    ┌───────────────────────────────────────────┐
                    │ Consumers                                 │
                    │  interactive-kp  (live, project schema v4)│
                    │  1c-tutor-kz     (planned)                │
                    └───────────────────┬───────────────────────┘
                                        │
             mb_publishable_* (browser, read-only) / mb_secret_* (backend)
                                        │
                    ┌───────────────────▼───────────────────────┐
                    │ MiniBase Worker        src/index.ts       │
                    │                                           │
                    │  rate limit → route → auth → origin       │
                    │                                           │
                    │  control plane   /v1/projects             │
                    │  (mb_management_*)  /v1/management-keys   │
                    │                     /v1/audit-events      │
                    │                     /v1/projects/{id}/…   │
                    │                                           │
                    │  data plane      /v1/data/{collection}    │
                    │  (mb_publishable_*  /v1/files/{path}      │
                    │   mb_secret_*)                            │
                    └──┬──────────────────┬─────────────────┬───┘
                       │ binding          │ HTTPS           │ binding
                ┌──────▼──────┐   ┌───────▼────────┐  ┌─────▼──────┐
                │ CONTROL_DB  │   │ api.cloudflare │  │  R2 FILES  │
                │ (D1)        │   │ .com D1 REST   │  │ key =      │
                │ projects    │   │ API            │  │ {projectId}│
                │ api_keys    │   │                │  │  /{path}   │
                │ mgmt_keys   │   └───────┬────────┘  └────────────┘
                │ prov_jobs   │           │
                │ audit_events│   ┌───────▼────────┐
                │ proj_origins│   │ project D1 × N │
                └─────────────┘   │ mb_records     │
                                  │ mb_files       │
                                  │ mb_users, …    │
                                  └────────────────┘
```

Key facts verified in code:

| Aspect | Reality |
| --- | --- |
| API versioning | Already `/v1/...` on every route (`src/index.ts`). No unversioned surface exists. |
| Project isolation | One D1 per project. The database UUID is resolved **only** from the key hash (`src/data-auth.ts`); no request can supply it. R2 objects are prefixed `{projectId}/` (`projectObjectKey`, `src/files-api.ts`). |
| Records model | A single generic document table `mb_records (collection, id, data JSON, created_at, updated_at)`, PK `(collection, id)`. Not relational. |
| Data plane transport | Cloudflare **D1 REST API**, not a binding — a deliberate, documented trade-off (ADR-0001). Workers for Platforms is paid and out of scope. |
| Migrations | Control DB: numbered SQL applied by Wrangler (`migrations/0001`–`0007`). Project DB: in-code `projectSchemaMigrations` v1–v4 with a version record in **two** places. |
| Transactions | Control plane uses `CONTROL_DB.batch()` (atomic). Data plane sends **one statement per HTTP call** — no multi-statement atomicity. |
| Idempotency | `POST /v1/projects` requires `Idempotency-Key` bound to a request fingerprint. Data-plane writes have none (PUT is naturally idempotent by ID). |
| Audit | `audit_events` in the control D1, append-only, control-plane actions only. Data-plane CRUD is intentionally not audited. |
| Auth | SHA-256 hash lookup; scopes stored as CSV; `project:admin` implies all data scopes. |
| Supabase tooling | `migration-manifest` / `-import` / `-verification` / `-rollback` / `postgres-sqlite` / `auth-migration` exist and are tested, but **no HTTP route reaches them**. Library-only. |
| Tests at audit time | 61 vitest tests + D1 + worker + release scripts. **No test exercised `src/index.ts` routing.** |

### Measured cost of one request

Counted by instrumenting the real handler (not estimated):

| Request | Control-D1 statements | Outbound D1 REST calls |
| --- | --- | --- |
| `GET /v1/data/{c}` with `Origin` | 3 (1 key read, 1 `last_used_at` write, 1 origin read) | 1 |
| `GET /v1/data/{c}` without `Origin` | 2 | 1 |
| denied data auth | 2 (1 key read + 1 audit insert) | 0 |

The `last_used_at` write is **the** structural cost: it made every authenticated
data request consume one control-plane write row, shared by all projects.

---

## 2. Scalability audit

| Area | Current | Problem / risk | Needed for future | Priority |
| --- | --- | --- | --- | --- |
| **A. Multi-project isolation** | One D1 per project; DB UUID resolved from key hash only; R2 prefix `{projectId}/` | Isolation was correct but **untested end-to-end**; a regression in routing would be silent. Both interpolated identities were unvalidated, so a corrupted control row could redirect the REST path or escape the R2 prefix | Regression tests proving A cannot read/write/list B's records or objects; an identity guard; per-project quotas and rate buckets | **P0 — tests in CP-01; quotas, buckets, and fail-closed identity guard in CP-03** |
| **B. Schema management** | Control: numbered SQL + Wrangler `d1_migrations`. Project: in-code v1–v4, `IF NOT EXISTS`, forward-only | Project `mb_schema_versions` is authoritative; verification endpoint reports drift; forward-only policy | Single source of truth + verify endpoint + regression tests | **P1 — done in CP-02** |
| **C. Relational data** | `mb_records` document store. Project schema v4 does use real FKs (`mb_users` → `mb_sessions` etc.) but the data API cannot express them | No FKs, joins, or referential integrity reachable through the API. `customers→projects→orders→tasks→artifacts` is not modelable today | Typed collections with declared FKs, or keep documents and add explicit link records — **decide only when a real project needs it** | P2 (CP-04) |
| **D. Query API** | CP-04: allowlisted `filter[...]`, `order=field.asc|desc`, `select=...`, opaque keyset cursor per order; still one D1 REST call per page and no `OFFSET` | Before CP-04 there was **no filtering, sorting, or field selection**: any query other than "by id" needed a full collection scan, and `nextAfter` on short final pages left consumers unable to tell when to stop | Filtering on indexed fields; explicit `order`; `hasMore` | **P0 — `hasMore` done in CP-01; filtering/sorting/selection done in CP-04** |
| **E. Index strategy** | CP-04: PK `(collection, id)` plus schema v5 composites on `created_at`, `updated_at`, and `json_extract(data,'$.schemaVersion')`, each ending in `id`; every supported query asserted against `EXPLAIN QUERY PLAN` | Before CP-04 the list query ordered by `id` only, so the v1 `(collection, updated_at DESC)` index was never used, and there was no index story for JSON fields | Rule kept: index only confirmed hot paths | **P1 — done in CP-04** |
| **F. Transactions** | Control plane: `batch()` is atomic. Data plane: `queryProjectD1` posts one `{sql, params}` — a single parameterized statement — and nothing in the codebase sends more than one statement per request | `create order + tasks + event` cannot be atomic today. Whether the REST endpoint accepts a batch is **unverified** and must not be assumed | Server-side commands. A single `INSERT` with multiple `VALUES` tuples is one SQLite statement and therefore atomic; whether that shape survives `queryProjectD1` is to be proven in CP-05, not assumed | P1 (CP-05) |
| **G. Idempotency** | Provisioning only (`Idempotency-Key` + request fingerprint) | Imports, bulk writes, webhooks and background jobs would duplicate on retry | One reusable primitive, applied to every write command | **P0 — primitive extracted in CP-01**; wiring P1 (CP-05) |
| **H. Audit log** | `audit_events`: project, action, outcome, actor, metadata, timestamp | No `entity` / `entity_id`, and **no correlation to the request** — `x-minibase-request-id` was returned to the caller but stored nowhere, so a support request could not be traced. Unbounded growth; a denied-auth storm writes one row each | `entity`, `entity_id`, `correlation_id`; retention policy | **P0 — contract done in CP-01**; retention P2 (CP-07) |
| **I. Files / R2** | Project-prefixed keys, path allowlist, `mb_files` metadata, `etag`, reconcile endpoint | Stored `size` came from the **client-declared `Content-Length`**, not measured bytes. No SHA-256 checksum. No file→entity relation. `content-length` on download came from metadata, which can be stale | Measured size (done), checksum + `uploaded_at` + entity link (needs project schema v5) | **P0 — measured size done in CP-01**; rest P2 (CP-06) |
| **J. Backup / restore** | D1 bookmark + R2 manifest appear only inside `migration-rollback.ts` as a rollback *plan* shape | No documented backup or restore procedure for normal operation, only for Supabase migrations | `docs/BACKUP_RESTORE.md` using free D1 export/PITR + R2 listing. No paid backup service | **P0 — documented in CP-01** |
| **K. Observability** | `observability.enabled: true`; request IDs on every response | No D1/R2 operation counts, no records/storage counts, no rate-limit event metric. Nothing tells the owner a quota is approaching | Cloudflare-native dashboards + a cheap `/v1/metrics`-style readout. Free tier only | P2 (CP-07) |
| **L. API versioning** | `/v1/...` everywhere | **None — already solved.** The audit brief assumed this might be missing; it is not | Nothing. Add `/v2` only when a breaking change is unavoidable | — |
| **M. Auth / authorization** | Three key classes, hash-stored, scoped, expiring, revocable, with rotation lineage. Browser writes blocked by design | No per-project scoping below `project:admin`; `scopes` is a CSV string. Fine for the current consumer count | Project-scoped keys and finer scopes **only when** a second consumer needs them. No IAM platform | P3 |
| **N. Rate limits / abuse** | Route class + IP + hashed credential; 64 KiB JSON, 25 MiB file, page ≤ 100 | All ceilings were **hard-coded**; one rate-limit namespace (120/60s) for every route; no per-project request budget | Configurable ceilings per deployment; per-route rate periods; per-project buckets; per-project payload quotas | **P0 — configurable in CP-01; per-route periods, per-project buckets, and per-project quotas in CP-03** |
| **O. Bulk operations** | None. `buildTableImportBatch` generates N statements but nothing executes or chunks them | Importing thousands of records would be one uncontrolled Worker request | Chunked import jobs with progress, resumable by checksum | P2 (CP-09) |

---

## 3. Main scalability risks

1. **D1 free-tier write enforcement now fails closed.** Since **2026-09-01**
   Cloudflare hard-fails D1 queries past the free daily row-read (5 M) and
   row-write (100 K) limits, on **both the Workers Binding API and the REST
   API** — which is exactly how MiniBase's data plane talks to project
   databases. MiniBase was writing one control-D1 row per authenticated data
   request (`UPDATE api_keys SET last_used_at`), so the whole deployment —
   every project together — was capped at roughly **100 000 authenticated data
   requests per day**, and unauthenticated scanning burned the same quota
   through audit inserts. *Mitigated in CP-01; see §6.*
2. **The control D1 is a shared single point of failure on the data hot path.**
   Two or three control-D1 statements precede every record read, for every
   project. A control-plane stall stops all tenants at once, and no project can
   be isolated from it. *Partially mitigated in CP-03: a per-project rate bucket
   is consulted before the origin lookup, so a tenant that exhausts its ceiling
   stops spending control-plane capacity at that point. The structural coupling
   itself remains and is CP-10's measurement subject.*
3. **The query API cannot express a real query.** No filter, no sort, no field
   selection, and the one secondary index is never used by the list query. Any
   project that grows past "fetch by id" will hit full-collection scans over the
   REST API — one HTTP round trip each.
4. **No atomic multi-record write.** Anything that must create an order, its
   tasks, and an event together cannot be made safe today.
5. **Project schema version has two sources of truth** that can silently
   diverge, and applying a version is a sequence of independent REST calls with
   no verification.

---

## 4. Already reusable (do not rebuild)

- Project isolation by per-project D1 + key-hash routing.
- `/v1` API versioning.
- Numbered control migrations under Wrangler, with a `d1_migrations` record.
- Ordered, idempotent, forward-only project schema versions.
- Idempotent provisioning with fingerprinted `Idempotency-Key` and rollback
  evidence.
- Append-only audit log with actor, outcome, and metadata.
- Route-class + IP + hashed-credential rate limiting, now with one optional
  binding per route class and a per-project bucket (CP-03).
- The CP-01 ceiling clamp in `src/limits.ts`, reused verbatim as the tighten-only
  rule for per-project quotas (CP-03).
- Unified `{ "error": { "code": ... } }` envelope with hardened response headers.
- R2 project-prefix isolation, path allowlist, metadata compensation on failure,
  and a read-only reconcile endpoint.
- Typed zero-dependency client SDK with strict key separation.
- Supabase portability library: manifest, checksums, Postgres→SQLite transform,
  verification report, rollback plan (needs an executor, not a rewrite).

## 5. Missing

- Filtering / sorting / field selection, and an index rule that matches the
  queries actually issued.
- Server-side commands with atomic multi-record writes.
- Idempotency on data-plane writes and imports.
- Chunked bulk import jobs.
- Audit retention, and metrics for D1/R2 operation counts and storage.
- Per-project **usage** quotas (record count, storage bytes, a distinct request
  rate number). CP-03 delivers per-project payload/page quotas and per-project
  rate *isolation*; a usage counter costs a control-D1 read or write per request
  and is deferred until CP-07 metrics and CP-10 measurements say what it would
  cost.
- File checksum, `uploaded_at`, and file→entity links.
- An HTTP surface for the existing Supabase migration library.
- A documented backup/restore procedure for normal operation.

---

## 6. Target architecture (minimal)

Same shape as today — the gaps are contracts, not components.

```text
              Project A / B / C
                     │
            authenticated API  /v1/...
                     │
   ┌─────────────────▼──────────────────────────┐
   │ MiniBase                                   │
   │  rate limit (per-route period,             │
   │              per-project bucket)           │  extend (CP-03)
   │  project isolation   (per-project D1 + R2, │
   │                       quotas, fail-closed) │  existing + extend (CP-03)
   │  query layer         (cursor, limits,      │  + filter/order (CP-04)
   │                       hasMore)             │
   │  command layer       (atomic, idempotent)  │  NEW (CP-05)
   │  migration manager   (verify + one source) │  extend (CP-02)
   │  audit               (+entity, +correlation)│ extended (CP-01)
   │  file metadata       (measured, checksum)  │  extend (CP-06)
   │  metrics             (free, CF-native)     │  NEW (CP-07)
   └──────────┬──────────────────────┬──────────┘
             D1                      R2
```

MiniBase must **not** become a Supabase clone, an ORM, a workflow engine, a
queue, an identity platform, or an analytics warehouse. Add a primitive only
when a named project needs it.

---

## 7. Gap matrix

| Current | Needed | Priority | Change type | Risk |
| --- | --- | --- | --- | --- |
| Untested isolation | Proven isolation regression tests | P0 | tests only | none |
| Ambiguous `nextAfter` | `hasMore` alongside it | P0 | additive field | none |
| Hard-coded ceilings | Env-configurable ceilings with hard maxima | P0 | additive | none |
| Idempotency inside `provision.ts` | Shared idempotency primitive | P0 | refactor | low |
| Audit without entity/correlation | `entity`, `entity_id`, `correlation_id` | P0 | additive migration 0007 | low |
| Client-declared file size | Measured size from the streamed body | P0 | behaviour fix | low |
| No backup/restore doc | `docs/BACKUP_RESTORE.md`, free tier only | P0 | docs | none |
| 1 control write per request | Throttled key-activity writes | P0 | behaviour change (metadata) | low |
| One rate-limit namespace for every route | One binding per route class, legacy binding kept as fallback | P0 | additive | none (done in CP-03) |
| No per-project request budget | `{route}:project:{projectId}` bucket, consulted before the origin read | P0 | additive | none (done in CP-03) |
| Deployment-wide ceilings only | Per-project tighten-only quotas on `projects`, read free by the auth join | P0 | additive migration 0008 | low (done in CP-03) |
| Interpolated identities unvalidated | `isSafeIdentity` guard at the authentication choke point | P0 | behaviour fix | low (done in CP-03) |
| No filter/sort/selection | Indexed filtering + explicit order | P1 | new query contract | medium |
| Unused secondary index | Index rule tied to measured queries | P1 | schema guidance | low |
| No atomic multi-write | Commands layer, single-statement atomic inserts | P1 | new endpoint | medium |
| Dual schema version source | Verification against `mb_schema_versions` | P1 | extend endpoint | low (done in CP-02) |
| No bulk import | Chunked, resumable import jobs | P2 | new endpoint | medium |
| No metrics | CF-native dashboards + counts endpoint | P2 | additive | low |
| No audit retention | Documented retention/rollup | P2 | ops + migration | low |
| No file checksum/entity link | Project schema v5 | P2 | schema + endpoint | medium (needs coordinated `schema/apply`) |
| Supabase library unwired | Import executor behind a route | P2 | new endpoint | medium |
| One D1 REST hop per query | Native binding / Workers for Platforms | — | **DEEP CHANGE — gated** | high |

---

## 8. Implementation plan

| Checkpoint | Scope | Deep change? |
| --- | --- | --- |
| **CP-01 Foundation hardening** | isolation + pagination + limits + idempotency + audit contract + measured file size + backup docs + tests | No — **implemented** |
| **CP-02 Schema & migrations** | one version source of truth, verification endpoint, documented forward-only policy | No — **implemented** |
| **CP-03 Project isolation** | per-project quotas, per-route rate periods, per-project rate buckets, fail-closed project context, isolation contract | No — **implemented** |
| **CP-04 Query + indexes** | allowlisted filtering, explicit ordering, field selection, keyset cursor per order, project schema v5 query indexes proven by `EXPLAIN QUERY PLAN` | No — **implemented** |
| CP-05 Commands + transactions + idempotency | server-side commands, atomic multi-record writes, `Idempotency-Key` on every write | No |
| CP-06 Files & artifact model | schema v5: checksum, `uploaded_at`, entity links, immutable originals | No, but needs a coordinated `schema/apply` per project |
| CP-07 Audit + observability | retention, metrics, quota alerts | No |
| CP-08 Backup/restore | scheduled export + verified restore rehearsal | No (paid backup services stay out) |
| CP-09 Migration compatibility | import executor + chunked jobs for the existing Supabase library | No |
| CP-10 Load / scalability verification | measured latency and quota behaviour before any paid step | No |

Order may change after CP-01 lands. Nothing in this plan replaces D1, R2, the
Worker, or the existing API contract.

---

## 9. Deep-change gate

Stop and get the owner's explicit approval before any of: replacing D1 or R2; a
new database engine, backend, repository, or VPS; PostgreSQL or Supabase;
Durable Objects as a storage model; external queue infrastructure; a full
identity platform; or any breaking change to the existing API.

**Deep change detected in this session: NO.** Everything in CP-01, CP-02, and
CP-03 is additive or a bug fix inside the existing architecture. CP-03 adds no
component: it extends the rate limiter that already existed, reuses the CP-01
ceiling clamp as its quota rule, and puts four nullable columns on a table the
authentication query already joins.

The one item on the horizon that *would* be a deep change is removing the D1
REST hop (ADR-0001 "Revisit when"). Its trigger is now measurable rather than
theoretical: watch D1 REST latency and the account's daily row counters. Do not
act on it before CP-10 produces numbers.
