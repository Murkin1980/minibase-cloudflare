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

## Not supported

Filtering, sorting, and field selection are not available. The API can fetch by
ID or walk a collection in ID order. Adding a query language is CP-04 and will be
driven by a real consumer's measured need, not speculatively.

## Project key lifecycle

- `GET /v1/projects/{projectId}/keys` lists metadata without hashes or raw keys.
- `POST /v1/projects/{projectId}/keys` issues or atomically rotates a key.
- `DELETE /v1/projects/{projectId}/keys/{keyId}` atomically revokes a key.

These operations require a management key with `keys:write`. A raw key is
returned once at creation. Publishable keys may use only `data:read` and
`files:read`. All write scopes and `project:admin` are restricted to secret
keys until MiniBase has end-user authentication and row-level authorization.

## Project schema

`POST /v1/projects/{projectId}/schema/apply` applies only missing, ordered,
idempotent project-schema versions. It requires management scope
`projects:write`. Current schema version is also tracked in the control D1.

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
