# MiniBase data API

## User sessions

- `POST /v1/sessions/exchange` — обмен publishable project key и валидного Cloudflare Access assertion на краткоживущий `mb_session_*`;
- `DELETE /v1/sessions/current` — отзыв текущей session token;
- session token поддерживает только унаследованные `data:read`/`data:write` scopes;
- одинаковые collection/id у разных Access subjects физически хранятся под разными hashed owner prefixes;
- list/get/put/delete никогда не возвращают physical owner prefix клиенту.

Project secret/publishable keys сохраняют прежнюю project-wide семантику для доверенных backend и закрытого single-owner compatibility.

## Records

- `GET /v1/data/{collection}`
- `GET /v1/data/{collection}/{id}`
- `PUT /v1/data/{collection}/{id}`
- `DELETE /v1/data/{collection}/{id}`

Publishable and secret keys are sent as Bearer tokens. The control plane stores
only their SHA-256 hashes.

## Project key lifecycle

- `GET /v1/projects/{projectId}/keys` lists metadata without hashes or raw keys.
- `POST /v1/projects/{projectId}/keys` issues or atomically rotates a key.
- `DELETE /v1/projects/{projectId}/keys/{keyId}` atomically revokes a key.

These operations require a management key with `keys:write`. A raw key is
returned once at creation. Publishable keys may use only `data:read` and
`data:write`; `project:admin` is restricted to secret keys.

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
