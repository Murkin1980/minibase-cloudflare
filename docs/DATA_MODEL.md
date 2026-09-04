# Data model

MiniBase has two kinds of database. The control plane has exactly one; every
project has its own.

## Control D1 (`minibase-control`)

Applied by Wrangler from `migrations/*.sql` in filename order, recorded in
Wrangler's own `d1_migrations` table.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `projects` | one row per tenant | `id` (UUID), `slug` UNIQUE, `status`, `d1_database_id` UNIQUE, `data_schema_version` |
| `api_keys` | publishable and secret data keys | `key_hash` UNIQUE (SHA-256 only), `project_id` → `projects`, `kind`, `scopes` CSV, `expires_at`, `revoked_at`, `last_used_at`, `rotated_from_key_id` |
| `management_keys` | control-plane keys | `key_hash` UNIQUE, `scopes` CSV, `expires_at`, `revoked_at`, `last_used_at`, `rotated_from_key_id` |
| `provisioning_jobs` | idempotent provisioning | `idempotency_key` PK, `request_hash`, `status`, `rollback_status`, `d1_database_id` |
| `audit_events` | append-only audit | `action`, `outcome`, `actor_key_id`, `entity`, `entity_id`, `correlation_id`, `metadata` JSON, `created_at` |
| `project_origins` | browser origin allowlist | PK `(project_id, origin)` |

No raw key value is ever stored. `scopes` is a comma-separated string;
`project:admin` implies every data scope.

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

Ordering is by `(collection, id)` — the primary key. `mb_records_collection_updated_idx
(collection, updated_at DESC)` exists but is **not** used by the list query;
adding an index without a query that uses it is waste, so it stays until CP-04
introduces ordering by `updated_at`.

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
