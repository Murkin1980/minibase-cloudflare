# MiniBase data API

Every route is versioned under `/v1`. There is no unversioned surface.

## Records

- `GET /v1/data/{collection}`
- `GET /v1/data/{collection}/{id}`
- `PUT /v1/data/{collection}/{id}`
- `DELETE /v1/data/{collection}/{id}`

Publishable and secret keys are sent as Bearer tokens. The control plane stores
only their SHA-256 hashes.

## Commands (CP-05)

CP-05 adds exactly one server-side command; it is **not** a generic batch or SQL
endpoint:

```http
POST /v1/commands/records:upsert-many
Authorization: Bearer mb_secret_...
Content-Type: application/json
Idempotency-Key: opaque-client-key

{
  "operations": [
    { "collection": "tasks", "id": "task-123", "data": { "schemaVersion": 1, "status": "created" } },
    { "collection": "task_events", "id": "event-456", "data": { "schemaVersion": 1, "taskId": "task-123" } }
  ]
}
```

A command atomically upserts **1 through the effective project
`maxBulkRecords`** distinct `(collection, id)` targets. `collection`, `id`, and
`data` use the same safe data shapes as the records API; command collections may
not begin with the internal `mb_` prefix. The body has exactly one field,
`operations`, and each operation has exactly `collection`, `id`, and `data`.
There is no `projectId`, database ID, SQL, SQL fragment, table name, or arbitrary
operation selector in the request.

Only a trusted `mb_secret_*` key with `data:write` (or its secret-key
`project:admin` scope) may execute the command. A publishable key is refused,
even if a malformed legacy control-plane row were to give it a write scope.
The authenticated key determines the project; commands never accept a tenant
address from the caller.

### Response and idempotency

`Idempotency-Key` is required, opaque, and limited to 100 characters. MiniBase
never returns it, logs it, or persists its raw value. The project D1 stores only
its SHA-256 digest, unique with the static command type inside that project's
own database.

A new command returns 200:

```json
{
  "commandId": "b5b9425b-7cf7-48bc-a039-6fdcd58a7e3d",
  "status": "applied",
  "operationCount": 2,
  "records": [
    { "collection": "tasks", "id": "task-123" },
    { "collection": "task_events", "id": "event-456" }
  ],
  "replayed": false
}
```

MiniBase canonicalizes JSON object-member order before fingerprinting. A retry
with the same key and the same normalized payload returns the persisted logical
response, the original `commandId`, and `"replayed": true`; it does **not**
write target records again or change their timestamps. Operation-array order is
intentional and remains part of the payload identity. A retry using the same key
with a different normalized payload receives the opaque response:

```http
HTTP/1.1 409 Conflict
{ "error": { "code": "idempotency_conflict" } }
```

The error does not reveal the old payload, request fingerprint, command ID, or
idempotency key. If a client loses a response or receives a transport error, it
must retry the exact same normalized command with the same key; the persisted
marker is the replay source of truth.

### Atomic mechanism, schema readiness, and cost

This is one parameterized project-D1 REST query for **every** fresh execution,
matching replay, and conflicting retry. The query is one SQLite
`INSERT … SELECT … ON CONFLICT … RETURNING` statement. It creates a v6
`mb_commands` marker and a static v6 trigger expands the already-validated
canonical JSON into `mb_records`. SQLite therefore commits all target upserts
and the completed marker together, or aborts the whole statement. It is not a
D1 REST `{batch}`, multiple SQL statements, a client-side rollback, sequential
legacy `PUT`s, or a generic command DSL.

The same statement checks the project database's authoritative
`mb_schema_versions` v6 row and the static trigger before it can insert a
marker. It does not make a schema-preflight request and does not consult
`projects.data_schema_version` for command readiness. An incomplete v6
installation that still has `mb_commands` but lacks the version row or trigger
returns 409 `command_schema_not_ready` with no target mutation. If the command
table itself is absent, MiniBase cannot safely distinguish that database error
from a Cloudflare transport error and returns the existing generic 502
`cloudflare_api_error`; it never falls back to legacy writes.

Run `GET /v1/projects/{projectId}/schema/verify` and owner-approved
`POST /v1/projects/{projectId}/schema/apply` before enabling this endpoint for an
existing project. CP-05 does **not** apply remote schema changes itself.

### Command errors

| Condition | HTTP | `error.code` |
| --- | ---: | --- |
| Missing, empty, or over-100-character key | 400 | `invalid_idempotency_key` |
| Empty/malformed body, unknown field, duplicate target | 400 | `invalid_command` |
| More operations than effective `maxBulkRecords` | 400 | `bulk_limit_exceeded` |
| Bad/internal collection, record ID, or data object | 400 | `invalid_collection`, `invalid_record_id`, `invalid_record_data` |
| Same key, different normalized payload | 409 | `idempotency_conflict` |
| v6 marker/trigger/version readiness is provably incomplete | 409 | `command_schema_not_ready` |
| Cloudflare/D1 transport or an indistinguishable absent table | 502 | `cloudflare_api_error` |

The normal data-plane origin allowlist, deployment and per-project quotas,
credential/IP/project rate controls, tenant isolation, error hardening, and
`/v1` versioning apply unchanged.

### Legacy writes remain available

`PUT /v1/data/{collection}/{id}` and `DELETE /v1/data/{collection}/{id}` remain
unchanged and do **not** require `Idempotency-Key`. A repeated PUT is logically
idempotent for the addressed document—the final `data` is the submitted value—
but its server-managed `updatedAt` can advance on each call. A repeated DELETE
is logically idempotent for the desired absent state and continues returning
204. Use the CP-05 command when multiple records must share one atomic outcome
and replayable response.

## Pagination

Keyset pagination only. There is no `OFFSET`, because offset cost grows with
depth and would make deep enumeration the cheapest way to exhaust a project's
quota.

| Parameter | Meaning |
| --- | --- |
| `limit` | page size, `1`…`maxPageSize` (default ceiling 100, default page 50) |
| `after` | cursor: the `nextAfter` of the previous page |

```json
{
  "records": [{ "id": "rec-1", "data": {}, "createdAt": "…", "updatedAt": "…" }],
  "nextAfter": "rec-1",
  "hasMore": false
}
```

**Use `hasMore` to decide whether to continue**, not `nextAfter !== null`.
`nextAfter` is the last cursor of the page and is also returned on a short final
page — it stays that way so consumers written before `hasMore` existed keep
working. Ordering is by record ID, which is the only stable order for a keyset
cursor over `mb_records`.

The same contract applies to `GET /v1/files`, where the cursor is the file path.

## Limits

All ceilings are configurable per deployment through Worker `vars`; the defaults
are the values MiniBase has always used. An override that is not a positive
integer within its hard maximum is ignored, so a typo can never widen an
unbounded request.

| Variable | Default | Hard maximum |
| --- | --- | --- |
| `MB_MAX_JSON_BYTES` | 65 536 | 1 MiB |
| `MB_MAX_FILE_BYTES` | 26 214 400 (25 MiB) | 100 MiB |
| `MB_MAX_PAGE_SIZE` | 100 | 500 |
| `MB_MAX_BULK_RECORDS` | 500 | 1 000 |
| `MB_KEY_ACTIVITY_INTERVAL_MS` | 300 000 | 3 600 000 |

`MB_MAX_BULK_RECORDS` is enforced by CP-05
`POST /v1/commands/records:upsert-many`; the authenticated project's effective
`maxBulkRecords` is the actual ceiling. See `src/limits.ts`.

These are **deployment** ceilings. Each one can be tightened per project — see
[Project quotas](#project-quotas) below and
[`PROJECT_ISOLATION.md`](PROJECT_ISOLATION.md).

## Query (CP-04)

`GET /v1/data/{collection}` accepts a **closed** query contract. MiniBase is not
an SQL gateway: every column name, operator, and sort direction below is chosen
by the server from a static allowlist in `src/record-query.ts`, and every value
travels as a bind parameter. There is no raw SQL, no raw `WHERE`, no raw
`ORDER BY`, no dynamic column name, and still no `OFFSET`.

```http
GET /v1/data/lessons?filter[schemaVersion]=2&filter[updatedAt.gte]=2026-09-01T00:00:00Z
                    &order=updatedAt.desc&select=id,data,updatedAt&limit=50&after=mbq1.…
```

### Filters — `filter[field]` / `filter[field.operator]`

| Field | Column / path | Operators |
| --- | --- | --- |
| `id` | `id` | `eq` |
| `createdAt` | `created_at` | `eq`, `gt`, `gte`, `lt`, `lte` |
| `updatedAt` | `updated_at` | `eq`, `gt`, `gte`, `lt`, `lte` |
| `schemaVersion` | `json_extract(data, '$.schemaVersion')` | `eq` |

The operator defaults to `eq` when omitted. Values are validated by field —
`schemaVersion` an integer, `id` a record ID, timestamps as below — so a
malformed value is a 400 rather than a bound value that silently matches
nothing. Ranges over `id` are not a filter; that is what the cursor is for.

#### Timestamp values are canonical UTC

`created_at` and `updated_at` are always written by `new Date().toISOString()`,
so **every stored value is canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`**. SQLite
compares those columns as TEXT, so a filter value in any other representation
would compare lexicographically against a different shape and silently return
the wrong rows: `2026-09-01T00:00:00+05:00` sorts *after* `2026-09-01T00:00:00.000Z`
as text even though it is the earlier instant.

A `createdAt` / `updatedAt` filter value therefore must be an ISO-8601 instant
**with an explicit timezone**, and is normalized to canonical UTC before it is
bound:

| Sent | Bound |
| --- | --- |
| `2026-09-01T00:00:00Z` | `2026-09-01T00:00:00.000Z` |
| `2026-09-01T00:00:00.000Z` | `2026-09-01T00:00:00.000Z` |
| `2026-09-01T05:00:00%2B05:00` | `2026-09-01T00:00:00.000Z` |
| `2026-08-31T19:00:00-05:00` | `2026-09-01T00:00:00.000Z` |

Equivalent instants therefore produce byte-identical bound values — and the same
cursor digest, so a page can be continued even if the client respells the same
timestamp. Rejected with 400 `invalid_filter`: a value with **no** timezone
(`2026-09-01T00:00:00`), a date-only value, a space separator, a non-ISO offset
(`+0500`), and a calendar date that does not exist (`2026-02-30`, `2025-02-29`),
which is rolled over silently by `Date.parse` alone and so is checked explicitly.

Note that `+` must be percent-encoded as `%2B` in a query string; an unencoded
`+` arrives as a space and is rejected rather than guessed at.

`schemaVersion` is the only JSON field, and it is here because every stored
document shape MiniBase's consumers use carries one and rolling documents
forward requires selecting by it. **A field is added only with a real query
behind it and an index under it**, never speculatively.

### Order — `order=field.direction`

`id`, `createdAt`, `updatedAt`, each `asc` or `desc`. `id` is always appended as
the final tie-breaker, so records sharing a timestamp still have exactly one
total order and a page boundary inside a run of equal values can neither skip
nor repeat a record. The default is `id.asc`.

### Select — `select=a,b`

`id`, `data`, `createdAt`, `updatedAt`. Selection shapes **the response only**.
It never narrows the SQL projection, the cursor, the filters, or authorization,
so it cannot be used to reach an internal column or to escape a check. An
unknown name is 400 `invalid_select`, not a silently dropped field.

### Cursor

| Query | `nextAfter` |
| --- | --- |
| no `filter` and no `order` | the record ID, exactly as before CP-04 |
| any `filter` or `order` | opaque `mbq1.<base64url>` |

The opaque cursor carries the sort value, the tie-breaker `id`, and a
**query-consistency digest** of the collection, filters, and order that produced
it. Pass it back unmodified. Anything else — a hand-made cursor, a truncated
one, or one issued for a different filter, order, or collection — is refused
with 400 `invalid_cursor`, so a paging client cannot silently receive a page
from a different query.

The digest is FNV-1a. It is **not** a cryptographic signature, the cursor is
**not** authenticated or tamper-proof, and a caller who wants to can construct
one that passes the check. That is acceptable because the digest protects
nothing: it exists to turn an accidentally reused cursor into a deterministic
400 instead of a wrong page. Isolation still comes from the key alone, as it
always has, and the `id` and sort value inside a cursor are re-validated and
bound as parameters on the way in.

### Errors

Unknown or malformed input is always **rejected**, never ignored:
`invalid_filter`, `invalid_operator`, `invalid_order`, `invalid_select`,
`invalid_cursor`, `invalid_limit` — all 400.

### Cost

One query is still **one D1 REST round trip** and one page is still one
statement with a `limit + 1` probe row. Each supported combination is proven to
use its intended index by `EXPLAIN QUERY PLAN` assertions against real SQLite in
`src/query-index.test.ts`.

### Still not supported

Arbitrary SQL, user-supplied SQL fragments, dynamic column names, joins, a
relation graph, full-text or fuzzy search, analytical queries, and `OFFSET`
pagination. Filtering on an arbitrary JSON field is not supported and will not
be until a real consumer need and an index exist for it.

## Project quotas

- `GET /v1/projects/{projectId}/quotas` reports the stored quota and the ceiling
  the Worker will actually enforce.
- `PUT /v1/projects/{projectId}/quotas` replaces the whole quota set.

Both require a management key with `projects:write` and a project whose `status`
is `active`.

```json
{
  "projectId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "configured": {
    "maxJsonBytes": 8192, "maxFileBytes": null,
    "maxPageSize": 90, "maxBulkRecords": null
  },
  "effective": {
    "maxJsonBytes": 8192, "maxFileBytes": 26214400,
    "defaultPageSize": 20, "maxPageSize": 20, "maxBulkRecords": 500
  }
}
```

`configured` is what is stored — `null` means "inherit the deployment ceiling",
which is what every pre-CP-03 project reports. `effective` is what is enforced;
read that one when sizing a client. The two differ whenever a stored quota
exceeds the deployment ceiling, because a quota may only **tighten** a limit,
never widen it.

`PUT` is a full replacement like `PUT .../origins`: an absent or explicitly
`null` field clears that quota, so replaying a body is idempotent. An unknown
field — including `keyActivityIntervalMs`, which is not a tenant quota — is
rejected with 400 `invalid_quota` rather than ignored.

Exceeding `maxJsonBytes`, `maxFileBytes`, or `maxPageSize` produces the existing
code a consumer already handles: 413 `request_body_too_large`, 413
`file_too_large`, or 400 `invalid_limit`. The CP-05 `maxBulkRecords` ceiling is
command-specific and returns 400 `bulk_limit_exceeded`.

Quotas cost no extra control-D1 statement: the columns ride along on the
`api_keys JOIN projects` query that authenticates the key.

## Rate limiting

Every non-health request is limited by route class (`control`, `data`, `files`)
and client IP, and additionally by a SHA-256 credential identity when one is
present. Once a request is authenticated, it is also limited by a **per-project**
bucket, `{route}:project:{projectId}`, so one tenant exhausting its ceiling does
not consume capacity its neighbours depend on.

Each route class can have its **own period**, declared as one rate-limit binding
per class (`RATE_LIMITER_CONTROL` / `RATE_LIMITER_DATA` / `RATE_LIMITER_FILES`).
A class with no binding of its own falls back to the pre-CP-03 shared
`RATE_LIMITER`, so an existing deployment behaves exactly as before. With
`MB_RATE_LIMITER_REQUIRED="true"` a route whose binding cannot be resolved fails
closed with 503 `rate_limiter_unavailable` instead of being served unlimited.

Rate-limit denials are not audited: a denial storm would otherwise consume the
control-D1 write quota the limiter protects. See
[`PROJECT_ISOLATION.md`](PROJECT_ISOLATION.md) §6 and
[`SECURITY.md`](SECURITY.md).

## Project key lifecycle

- `GET /v1/projects/{projectId}/keys` lists metadata without hashes or raw keys.
- `POST /v1/projects/{projectId}/keys` issues or atomically rotates a key.
- `DELETE /v1/projects/{projectId}/keys/{keyId}` atomically revokes a key.

These operations require a management key with `keys:write`. A raw key is
returned once at creation. Publishable keys may use only `data:read` and
`files:read`. All write scopes and `project:admin` are restricted to secret
keys until MiniBase has end-user authentication and row-level authorization.

## Project schema

- `GET /v1/projects/{projectId}/schema/verify` (or `GET /v1/projects/{projectId}/schema`)
  inspects the project's authoritative `mb_schema_versions` table, compares it
  against the control D1 cache, detects drift, and lists pending versions.
- `POST /v1/projects/{projectId}/schema/apply` applies only missing, ordered,
  idempotent project-schema versions based on the project database's authoritative
  state, and synchronizes the control D1 cache.

These operations require a management key with `projects:write`. Inconsistent
migration states fail safe with HTTP 409 (`inconsistent_schema_state`).

## Isolation and fail-closed behaviour

No data-plane route accepts a project identifier: the project is a consequence of
the credential. When the project context cannot be established with certainty —
unknown, revoked, or expired key; inactive project; missing or malformed database
UUID; insufficient scope — the request is refused with an identical 401 and no
backend is contacted, so a caller cannot tell those cases apart or discover
whether a project exists. The distinguishing reason is recorded in the audit log
instead. Full contract: [`PROJECT_ISOLATION.md`](PROJECT_ISOLATION.md).

## Files

- `GET /v1/files?limit=50&after=...` lists metadata.
- `GET /v1/files/{path}` streams an object.
- `PUT /v1/files/{path}` streams an upload up to 25 MiB.
- `DELETE /v1/files/{path}` removes an object and its metadata.

Files require `files:read` or `files:write`. R2 keys always begin with the
authenticated project ID; callers cannot supply or override that prefix.
Uploads require `Content-Length`. If project-D1 metadata persistence fails after
an R2 upload, the Worker deletes the new object as compensation.

`GET /v1/projects/{projectId}/files/reconcile` performs a read-only comparison
of up to 1000 project metadata rows and R2 objects. It reports orphaned R2
objects and metadata entries whose objects are missing; it never deletes either.
