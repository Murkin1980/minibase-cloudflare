# Data model

MiniBase has two kinds of database. The control plane has exactly one; every
project has its own.

## Control D1 (`minibase-control`)

Applied by Wrangler from `migrations/*.sql` in filename order, recorded in
Wrangler's own `d1_migrations` table.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `projects` | one row per tenant | `id` (UUID), `slug` UNIQUE, `status`, `d1_database_id` UNIQUE, `data_schema_version`, `quota_max_json_bytes`, `quota_max_file_bytes`, `quota_max_page_size`, `quota_max_bulk_records` |
| `api_keys` | publishable and secret data keys | `key_hash` UNIQUE (SHA-256 only), `project_id` → `projects`, `kind`, `scopes` CSV, `expires_at`, `revoked_at`, `last_used_at`, `rotated_from_key_id` |
| `management_keys` | control-plane keys | `key_hash` UNIQUE, `scopes` CSV, `expires_at`, `revoked_at`, `last_used_at`, `rotated_from_key_id` |
| `provisioning_jobs` | idempotent provisioning | `idempotency_key` PK, `request_hash`, `status`, `rollback_status`, `d1_database_id` |
| `audit_events` | append-only audit | `action`, `outcome`, `actor_key_id`, `entity`, `entity_id`, `correlation_id`, `metadata` JSON, `created_at` |
| `project_origins` | browser origin allowlist | PK `(project_id, origin)` |

No raw key value is ever stored. `scopes` is a comma-separated string;
`project:admin` implies every data scope.

### Per-project quotas (CP-03)

The four `projects.quota_*` columns are nullable `INTEGER`s with
`CHECK (col IS NULL OR col > 0)`, added by `migrations/0008_project_quotas.sql`.
`NULL` means "inherit the deployment ceiling from `src/limits.ts`", which is what
every project provisioned before CP-03 holds, so the migration changes nothing for
an existing tenant.

They are columns on `projects` rather than a separate table because the
data-plane authentication query already joins `projects`: a quota therefore costs
**zero** additional control-D1 statements on the hot path. A `project_quotas`
table would have added one read per authenticated request, re-creating the
coupling CP-01 removed.

A stored value may only **tighten** the deployment ceiling, never widen it — see
[`PROJECT_ISOLATION.md`](PROJECT_ISOLATION.md) §4 for the full contract.
`keyActivityIntervalMs` is deliberately not a quota: it sizes a control-D1 write
budget shared by every tenant.

### Interpolated identities

`projects.id` and `projects.d1_database_id` are the only two values MiniBase
interpolates instead of binding as parameters, because both are addresses and not
data: the project ID becomes the R2 key prefix, and the database UUID becomes a
segment of the Cloudflare REST path. Both are validated against
`isSafeIdentity` (`src/security.ts`) during authentication, and a row that fails
is refused with 401 before any backend is contacted.

### Audit event contract

`audit_events` is append-only: nothing in MiniBase updates or deletes a row.

| Field | Meaning |
| --- | --- |
| `project_id` | affected tenant, `NULL` for account-level actions |
| `action` | dotted verb, e.g. `data.auth`, `project.provisioned`, `data_key.revoked` |
| `outcome` | `success` \| `denied` \| `failed` |
| `actor_key_id` | management key that acted, `NULL` for data-plane denials |
| `entity` | `project` \| `data_key` \| `management_key` \| `file` \| `origin` |
| `entity_id` | identifier of the affected entity |
| `correlation_id` | the `x-minibase-request-id` the caller received, so a support report can be traced to its events |
| `metadata` | small JSON of non-sensitive context, e.g. `{"reason":"revoked"}` |

Never stored: raw bearer tokens, key hashes, record payloads, or user content.

Successful data-plane reads and writes are **deliberately not audited** — at
MiniBase's request volumes that would be the largest write source in the system.
Only denials and control-plane mutations are.

### Why `last_used_at` is approximate

`api_keys.last_used_at` and `management_keys.last_used_at` are written at most
once per key per `keyActivityIntervalMs` (default 5 minutes), not on every
request. They are key-hygiene metadata for rotation decisions. Revocation and
expiry are re-checked from the row on **every** request, so throttling the write
does not weaken authorization. See `docs/SCALABILITY.md` §3 for the quota reason.

## Project D1 (`mb-<slug>`)

Applied by `src/project-schema.ts`, one version at a time, forward-only, every
statement `IF NOT EXISTS`.

| Version | Tables added |
| --- | --- |
| 1 | `mb_schema_versions` (version record), `mb_records` + index |
| 2 | `mb_files` + index |
| 3 | `mb_migration_imports` (Supabase import bookkeeping) |
| 4 | `mb_users`, `mb_activation_tokens`, `mb_organization_memberships`, `mb_sessions`, `mb_auth_audit_events` + indexes |
| 5 | CP-04 query indexes on `mb_records` — **indexes only**, no table or column change |

### `mb_records`

```sql
collection TEXT NOT NULL,
id         TEXT NOT NULL,
data       TEXT NOT NULL,   -- JSON object
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
PRIMARY KEY (collection, id)
```

A document store, not a relational table. There are no foreign keys, joins, or
per-field indexes reachable through the data API. Collections are logical
partitions inside one physical table, which is what keeps provisioning cheap and
schema-free for small projects.

Ordering defaults to `(collection, id)` — the primary key — and CP-04 added the
optional orders `createdAt` and `updatedAt`, each with `id` as the final
tie-breaker.

Project schema v5 adds exactly the indexes those queries use, and nothing else:

| Index | Serves |
| --- | --- |
| `mb_records_collection_created_id_idx (collection, created_at, id)` | `order=createdAt.*`, `filter[createdAt.*]` |
| `mb_records_collection_updated_id_idx (collection, updated_at, id)` | `order=updatedAt.*`, `filter[updatedAt.*]` |
| `mb_records_collection_schema_version_id_idx (collection, json_extract(data,'$.schemaVersion'), id)` | `filter[schemaVersion]` |

Each one ends in `id` because `id` is the tie-breaker every keyset cursor uses;
without it a page boundary inside equal timestamps could skip or repeat rows.
The `schemaVersion` index is an **expression** index over a fixed JSON path — the
same path the query builder emits, which is the only reason SQLite can match it.
No generated column and no `ALTER TABLE` were needed, so v5 upgrades a populated
project database as a pure metadata operation that cannot touch a record.

`mb_records_collection_updated_idx (collection, updated_at DESC)` from v1 is
still unused by any query — the CP-04 orders match the v5 composite instead. It
is kept: removing an index is a separate change with its own justification, not
a side effect of adding a query API.

Indexes are added only for a query that exists. There is deliberately **no**
generic index over arbitrary JSON fields.

### `mb_files`

```sql
path         TEXT PRIMARY KEY,
size         INTEGER NOT NULL,   -- measured from the streamed body
content_type TEXT,
etag         TEXT NOT NULL,
created_at   TEXT NOT NULL,
updated_at   TEXT NOT NULL
```

Metadata for objects in the shared R2 bucket under `{projectId}/{path}`. `size`
is the number of bytes R2 actually received, not the client's `Content-Length`.
A SHA-256 checksum, an explicit `uploaded_at`, and file→entity links are planned
for CP-06 and need a project schema v5.

### Version bookkeeping

The applied schema version is authoritatively recorded in `mb_schema_versions
(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)` in the project's own
D1 database.

The control plane's `projects.data_schema_version` stores a cached /
last-observed version value. Planning and migration execution query the project's
`mb_schema_versions` directly, and `GET /v1/projects/{projectId}/schema/verify`
reports any mismatch or drift. When migrations are applied or synchronized, the
control-plane cache is updated to match the project's authoritative state.
