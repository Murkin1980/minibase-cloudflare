# MiniBase architecture

MiniBase is a compact multi-project BaaS on Cloudflare Workers, D1, and R2. It
is deliberately not a Supabase clone, an ORM, a workflow engine, a queue, or an
identity platform. It provides reusable primitives and nothing else.

For the audit that produced this shape, the risk list, and the roadmap, see
[`docs/SCALABILITY.md`](docs/SCALABILITY.md).

## Request path

```text
consumer app
   │  Bearer mb_publishable_* (browser, read-only)
   │  Bearer mb_secret_*      (trusted backend only)
   │  Bearer mb_management_*  (control plane only)
   ▼
Worker  src/index.ts
   1. resolve or generate x-minibase-request-id
   2. rate limit   src/abuse-control.ts   route class + IP + SHA-256 credential
   3. route        /health | /v1/...
   4. authenticate src/data-auth.ts | src/management-keys.ts   hash lookup in CONTROL_DB
   5. origin check src/cors.ts            project_origins allowlist
   6. execute      src/data-api.ts | src/files-api.ts
   7. harden       src/response-security.ts
   ▼
CONTROL_DB (D1 binding)      api.cloudflare.com D1 REST API      R2 (binding)
projects, api_keys,          one database per project            key = {projectId}/{path}
management_keys,             mb_records, mb_files, mb_users …
provisioning_jobs,
audit_events, project_origins
```

## Why the data plane uses the D1 REST API

A D1 Worker binding is fixed at deploy time and cannot be constructed from a
database UUID at request time. MiniBase must serve one endpoint for many
projects, each with its own database, on the free plan. The REST hop is the
accepted trade-off and is recorded in
[`docs/ADR-0001-data-plane-routing.md`](docs/ADR-0001-data-plane-routing.md),
together with the conditions for revisiting it.

Consequences that shape the design:

- **`queryProjectD1` posts a single `{sql, params}` per call**, so the data plane
  as built has no multi-statement transaction — atomicity has to come from
  single statements;
- **one HTTPS round trip per query**, so round trips must be minimized rather
  than assumed cheap;
- **the account's D1 quota is shared** across every project, so per-request
  control-plane writes are a platform-wide ceiling, not a per-project one.

## Isolation model

| Boundary | Mechanism |
| --- | --- |
| project → database | `api_keys.key_hash` joins `projects`; the database UUID is never accepted from a request |
| project → objects | `projectObjectKey()` prefixes every R2 key with the authenticated project ID |
| browser → writes | publishable keys are limited to `data:read` and `files:read`; write scopes require `mb_secret_*` |
| caller → SQL | collection, record ID, and file path pass allowlist regexes and are bound as parameters; arbitrary SQL is never accepted |
| caller → tenant | browser `Origin` must appear in that project's `project_origins` allowlist |

## Control plane vs data plane

The control plane (`mb_management_*`) owns provisioning, keys, origins, schema
application, and audit. It writes to `CONTROL_DB` through `batch()`, which is
atomic.

The data plane (`mb_publishable_*` / `mb_secret_*`) owns records and files. It
never touches `CONTROL_DB` except to authenticate, and it writes key-activity
metadata at most once per key per interval rather than per request.

## Documents

| File | Contents |
| --- | --- |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | every table, in both databases |
| [`docs/DATA_API.md`](docs/DATA_API.md) | endpoint contracts |
| [`docs/AUTH.md`](docs/AUTH.md) | identity and session boundary |
| [`docs/SECURITY.md`](docs/SECURITY.md) | threat model, headers, limits |
| [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md) | schema change policy |
| [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md) | backup, restore, verification |
| [`docs/SCALABILITY.md`](docs/SCALABILITY.md) | audit, risks, gap matrix, checkpoints |
| [`docs/SUPABASE_MIGRATION.md`](docs/SUPABASE_MIGRATION.md) | portability layer |
| [`docs/CLIENT_SDK.md`](docs/CLIENT_SDK.md) | TypeScript client |
