# MiniBase data API

Every route is versioned under `/v1`. There is no unversioned surface.

## Records

- `GET /v1/data/{collection}`
- `GET /v1/data/{collection}/{id}`
- `PUT /v1/data/{collection}/{id}`
- `DELETE /v1/data/{collection}/{id}`

Publishable and secret keys are sent as Bearer tokens. The control plane stores
only their SHA-256 hashes.

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

`MB_MAX_BULK_RECORDS` is reserved for the CP-05 command layer; nothing reads it
yet. See `src/limits.ts`.

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
timestamps must be ISO-8601, `schemaVersion` an integer, `id` a record ID — so a
malformed value is a 400 rather than a bound value that silently matches
nothing. Ranges over `id` are not a filter; that is what the cursor is for.

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

The opaque cursor carries the sort value, the tie-breaker `id`, and a digest of
the collection, filters, and order that produced it. Pass it back unmodified.
Anything else — a hand-made cursor, a truncated one, or one issued for a
different filter, order, or collection — is refused with 400 `invalid_cursor`,
so a paging client cannot silently receive a page from a different query. The
digest is a consistency check, not a security control: isolation still comes
from the key alone, as it always has.

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

Exceeding a quota produces the code a consumer already handles, never a new one:
413 `request_body_too_large`, 413 `file_too_large`, or 400 `invalid_limit`.

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
