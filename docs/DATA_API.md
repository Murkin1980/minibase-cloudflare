# MiniBase data API

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
