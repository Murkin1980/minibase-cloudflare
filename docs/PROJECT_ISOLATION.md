# Project isolation contract (CP-03)

This is the contract a consumer integrates against. It states what MiniBase
guarantees about one project not affecting another, what a project may be limited
to, and what happens when the project context is missing or wrong.

Audience: any application that will hold `mb_publishable_*` or `mb_secret_*` keys
— today `interactive-kp`, later `1c-tutor-kz` and the rest of the MPE ecosystem.

Scope note: this document describes CP-03 of the vNext upgrade
(`docs/SCALABILITY.md` §8). It is **EXTEND_EXISTING** work — one Worker, one
control D1, one shared R2 bucket, one D1 per project. No new backend, database
engine, or repository.

---

## 1. Guarantees

| # | Guarantee | Mechanism | Proof |
| --- | --- | --- | --- |
| G1 | A credential reaches **only** its own project's database | The database UUID is resolved from `api_keys.key_hash JOIN projects`. It is never accepted from a request. | `src/isolation.test.ts` |
| G2 | A credential reaches **only** its own project's objects | Every R2 key is `{projectId}/{path}`; the prefix comes from the authenticated principal. | `projectObjectKey`, `src/isolation.test.ts` |
| G3 | A path naming another project stays inside the caller's own prefix | `projectObjectKey(principal("a"), "project-b/x")` → `a/project-b/x` | `src/isolation.test.ts` |
| G4 | A browser is bound to **its own** project's origin allowlist | `project_origins(project_id, origin)` | `src/cors.ts` |
| G5 | One project's **quota** does not change another's | Quotas are per-project columns, resolved per authenticated principal | `src/project-quotas.ts` |
| G6 | One project's **rate bucket** does not change another's | `{route}:project:{projectId}` key, one bucket per project per route class | `src/abuse-control.ts` |
| G7 | One route class's **period** does not change another's | One optional rate-limit binding per route class | `rateLimiterFor` |
| G8 | A malformed project context is **refused**, not repaired | `isSafeIdentity` at the single authentication choke point | `src/data-auth.ts` |
| G9 | A caller cannot discover **whether a project exists** | Every project-context failure returns an identical 401 | `src/isolation.test.ts` |
| G10 | A project can never **widen** a deployment ceiling | Tighten-only clamp, bounded by `HARD_LIMITS` | `resolveProjectQuota` |

Guarantees G1–G4 existed before CP-03 and are unchanged. CP-03 adds G5–G10 and
proves all ten with tests.

---

## 2. How a project is identified

**There is no project identifier in any data-plane request.** Not in the path,
not in a header, not in the body. The project is a consequence of the credential:

```text
Bearer mb_secret_…  →  SHA-256  →  api_keys.key_hash  →  api_keys.project_id
                                                     →  projects.d1_database_id
```

Consequences a consumer must design around:

- You cannot ask MiniBase for "project X's records" with project Y's key. There
  is no syntax for it.
- A consumer that serves several projects must hold **one key pair per project**
  and select the key, not a header. This is the intended shape for the MPE
  ecosystem: each application gets its own project.
- The control plane (`mb_management_*`) is the only surface that names a project
  explicitly, in the path, and it is account-level: a management key is trusted
  with every project. Per-project management scoping is deliberately **not**
  provided (`docs/SCALABILITY.md` item M, P3 — no IAM platform).

---

## 3. Fail-closed behaviour

MiniBase fails closed on project context. The rule is: **if the project cannot be
established with certainty, the request is refused and no backend is touched.**

| Situation | Result | Backend calls made |
| --- | --- | --- |
| No `Authorization` header | 401 `unauthorized` | none |
| Header is not `mb_publishable_*` / `mb_secret_*` | 401 `unauthorized` | none |
| Key hash not found | 401 `unauthorized` | none |
| Key revoked | 401 `unauthorized` | none |
| Key expired | 401 `unauthorized` | none |
| Project `status` is not `active` | 401 `unauthorized` | none |
| `projects.d1_database_id` is NULL or empty | 401 `unauthorized` | none |
| **`d1_database_id` is not a safe identity** (CP-03) | 401 `unauthorized` | none |
| **`project_id` is not a safe identity** (CP-03) | 401 `unauthorized` | none |
| Key lacks the required scope | 401 `unauthorized` | none |
| Browser `Origin` not in the project allowlist | 403 `origin_not_allowed` | none |
| Project rate bucket exhausted | 429 `rate_limited` | none |
| **Rate limiting required but no binding resolves** (CP-03) | 503 `rate_limiter_unavailable` | none |

### Why "safe identity" is checked at all

Two values are *interpolated* rather than bound as SQL parameters, because both
are addresses and not data:

- `projects.d1_database_id` becomes a path segment of
  `https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{databaseId}/query`;
- `projects.id` becomes the prefix of every R2 key.

Both come from the control plane, so neither is attacker-controlled. But a
hand-edited, truncated, or corrupted control row is a real failure mode, and
either value could then redirect the data plane to another Cloudflare API path or
write an object outside its tenant prefix. `isSafeIdentity` (`src/security.ts`)
requires `^[A-Za-z0-9-]{1,64}$`: dots are excluded, so `..` cannot be expressed
at all, and `/ ? # %` and whitespace are excluded, so no path or query boundary
can be injected. Canonical UUIDs — everything MiniBase actually issues — always
satisfy it.

The check lives in `dataKeyDenialReason`, the single choke point every data-plane
request passes through, so both the Records API and the Files API are covered by
one rule.

### No project-existence leakage

Every project-context failure in the table above returns the **same** status and
the **same** body:

```http
HTTP/1.1 401
{ "error": { "code": "unauthorized" } }
```

An unknown credential, a suspended project, a project with no database, and a
project with a corrupted database id are indistinguishable from the outside. A
probe therefore cannot enumerate which projects exist or which are
misconfigured.

The distinguishing detail is not lost — it goes to the append-only audit log as
`data.auth` / `outcome = denied` / `metadata.reason`
(`unknown_key`, `project_inactive`, `project_unavailable`, `scope`, …), with the
CP-01 `correlation_id` tying it to the `x-minibase-request-id` the caller
received. **Operators can diagnose; callers cannot enumerate.**

### Rate limiting is not audited

A rate-limit denial writes **no** audit row. A denial storm would otherwise write
one control-D1 row per rejected request, consuming the same daily row-write quota
the limiter exists to protect. Rate-limit events are observable through
Cloudflare's own dashboards instead (`observability.enabled: true`).

---

## 4. Per-project quotas

### What a quota is

A quota is a **tighten-only** override of a deployment ceiling. The relationship
is strict and one-directional:

```text
HARD_LIMITS[key]  >=  deployment ceiling (Worker vars)  >=  project quota  =  enforced value
```

| Layer | Set by | Changes with |
| --- | --- | --- |
| `HARD_LIMITS` | code (`src/limits.ts`) | a release |
| deployment ceiling | Worker `vars`, e.g. `MB_MAX_PAGE_SIZE` | a deploy |
| project quota | `PUT /v1/projects/{id}/quotas` | a request, no deploy |
| **enforced value** | `min` of the above | — |

So a project can be given a *smaller* allowance than the deployment, and can
never be given a larger one — not through the endpoint, and not by editing
`projects.quota_*` directly in the control D1. An invalid stored value is
**ignored**, which means the project inherits the deployment ceiling; it never
widens anything.

### Quota dimensions

| Quota | Column | Deployment variable | Hard maximum | Enforced on |
| --- | --- | --- | --- | --- |
| `maxJsonBytes` | `projects.quota_max_json_bytes` | `MB_MAX_JSON_BYTES` | 1 MiB | `PUT /v1/data/...` body |
| `maxFileBytes` | `projects.quota_max_file_bytes` | `MB_MAX_FILE_BYTES` | 100 MiB | `PUT /v1/files/...` body |
| `maxPageSize` | `projects.quota_max_page_size` | `MB_MAX_PAGE_SIZE` | 500 | `?limit=` on every list route |
| `maxBulkRecords` | `projects.quota_max_bulk_records` | `MB_MAX_BULK_RECORDS` | 1 000 | reserved for CP-05 |

`defaultPageSize` is derived, never stored: it is
`min(deployment defaultPageSize, effective maxPageSize)`, so a page default can
never exceed the page maximum it belongs to.

**`keyActivityIntervalMs` is deliberately not a quota.** It sizes the control-D1
`last_used_at` write budget shared by *every* tenant. Letting one project raise
it would raise the whole deployment's write volume — precisely the account-wide
ceiling CP-01 removed. It is inherited unchanged and the quotas endpoint rejects
it as an unknown field.

### Error codes are unchanged

A quota never introduces a new error. Exceeding one produces the code a consumer
already handles:

| Quota exceeded | HTTP | `error.code` |
| --- | --- | --- |
| `maxJsonBytes` | 413 | `request_body_too_large` |
| `maxFileBytes` | 413 | `file_too_large` |
| `maxPageSize` | 400 | `invalid_limit` |

A consumer written before CP-03 therefore needs **no error-handling change**.

### Cost

**Zero additional control-D1 statements.** The quota columns ride along on the
`api_keys JOIN projects` query that authentication already runs. This is why
quotas are columns on `projects` and not a separate table: a `project_quotas`
table would have added one read to every authenticated request, re-creating the
hot-path coupling CP-01 removed.

---

## 5. Quota management API

Both routes require a management key with `projects:write`, and both are
restricted to a project whose `status` is `active` — exactly like every other
project-scoped control-plane route.

### Read

```http
GET /v1/projects/{projectId}/quotas
Authorization: Bearer mb_management_...
```

```json
{
  "projectId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "configured": {
    "maxJsonBytes": 8192,
    "maxFileBytes": null,
    "maxPageSize": 90,
    "maxBulkRecords": null
  },
  "effective": {
    "maxJsonBytes": 8192,
    "maxFileBytes": 26214400,
    "defaultPageSize": 20,
    "maxPageSize": 20,
    "maxBulkRecords": 500
  }
}
```

- `configured` is what is **stored**. `null` means "inherit the deployment
  ceiling", which is what every project provisioned before CP-03 reports.
- `effective` is what the Worker will **actually enforce**. Read this one when
  you need to size a client.
- The two differ whenever a stored quota exceeds the deployment ceiling — above,
  `maxPageSize` is configured as 90 but the deployment allows 20, so 20 is
  enforced. Reporting both is deliberate: hiding the clamp would make a quota
  look applied when it is not.
- `keyActivityIntervalMs` is absent from `effective` because it is not a tenant
  quota.

An unconfigured project reports `configured` all `null` and `effective` equal to
the deployment ceilings.

### Replace

```http
PUT /v1/projects/{projectId}/quotas
Authorization: Bearer mb_management_...
Content-Type: application/json

{ "maxJsonBytes": 8192, "maxPageSize": 25 }
```

Returns the same body as `GET`.

**`PUT` is a full replacement**, matching `PUT /v1/projects/{id}/origins`. A
field that is absent or explicitly `null` is stored as `NULL` and that quota
reverts to the deployment ceiling. Replaying an identical body produces an
identical row, so the call is idempotent — there is no separate PATCH.

Validation, at write time:

| Rule | Result |
| --- | --- |
| Body is not a JSON object | 400 `body_must_be_object` |
| Unknown field (including `keyActivityIntervalMs`) | 400 `invalid_quota` |
| Value not a positive integer | 400 `invalid_quota` |
| Value above the hard maximum | 400 `invalid_quota` |
| Project missing or not `active` | 404 `project_not_found` |

An unknown field is **rejected, not ignored**, so a misspelled quota can never
look like it was applied.

Values are checked against the *hard maximum*, not against the current
deployment ceiling. Deployment `vars` are an operator decision that can change
between requests; the runtime clamp is what guarantees tighten-only. Rejecting a
value only because today's deployment happens to be stricter would make the
stored quota silently depend on configuration.

The update and its audit event are written through `CONTROL_DB.batch()`, which is
atomic, so a quota change is never visible without its audit trail:

```text
action          project.quotas_replaced
outcome         success
entity          project
entity_id       {projectId}
correlation_id  {x-minibase-request-id}
metadata        the quota integers only — no key material, no record payload
```

Quota changes take effect on the **next** request. There is no cache to
invalidate, because the quota is read by the authentication query itself.

---

## 6. Rate limiting

### Three dimensions

| Dimension | Key | Known when | Purpose |
| --- | --- | --- | --- |
| client IP | `{route}:ip:{cf-connecting-ip}` | before auth | stop an unauthenticated scan |
| credential | `{route}:token:{sha256(bearer)}` | before auth | stop credential rotation bypassing the IP ceiling |
| **project** (CP-03) | `{route}:project:{projectId}` | after auth | stop one tenant consuming shared capacity |

Route classes are `control`, `data` (`/v1/data/…`), and `files` (`/v1/files…`).
Every other path, including `/v1/projects`, `/v1/management-keys`, and
`/v1/audit-events`, is `control`.

The project bucket is consulted **after** authentication and **before** the
origin lookup — the origin lookup is itself a control-D1 read, so an exhausted
project stops spending control-plane capacity at that point rather than after it.

Raw credentials never become rate-limit keys; only their SHA-256.

### Per-route periods

A Cloudflare rate-limit binding carries its own `limit` and `period`; the
`limit()` call accepts only a key. Per-route periods are therefore declared as
**one binding per route class**, not passed as arguments:

```jsonc
"unsafe": {
  "bindings": [
    { "name": "RATE_LIMITER_CONTROL", "type": "ratelimit",
      "namespace_id": "…", "simple": { "limit": 60,  "period": 60 } },
    { "name": "RATE_LIMITER_DATA",    "type": "ratelimit",
      "namespace_id": "…", "simple": { "limit": 600, "period": 60 } },
    { "name": "RATE_LIMITER_FILES",   "type": "ratelimit",
      "namespace_id": "…", "simple": { "limit": 120, "period": 60 } }
  ]
}
```

Resolution order per route class: **its own binding, then the pre-CP-03 shared
`RATE_LIMITER`**. Keeping the shared binding as the fallback is what makes CP-03
backward compatible — an already-deployed Worker with a single namespace
(production namespace `22001`, 120 calls per 60 seconds) behaves exactly as
before until the owner approves separate ones. See `wrangler.example.jsonc`.

This closes a launch blocker listed in `docs/SECURITY.md`: with one namespace for
every route, a browser polling `/v1/data` could starve the control plane.

### What per-project rate limiting can and cannot do

Be explicit about this, because it shapes what a consumer may expect.

- **Can:** give each project its own bucket, so project A exhausting its ceiling
  does not slow or block project B. This is real isolation, and it is what
  protects the account-wide D1 row quota that every tenant shares.
- **Cannot:** give project A a *different number* from project B. The `limit` and
  `period` belong to the binding, and a binding is deployment-wide. A per-project
  numeric request rate would need a counter MiniBase maintains itself, which
  means a control-D1 write per request per project — the exact coupling CP-01
  removed.

Per-project numeric ceilings therefore exist for **payload size and page size**
(§4), and per-project isolation exists for **request rate** (§6). If a named
project ever needs a distinct request *number*, that is a scoped decision with a
measured cost, not a configuration flag.

### Fail-closed switch

`MB_RATE_LIMITER_REQUIRED="true"` makes a rate-limited route whose binding cannot
be resolved return **503 `rate_limiter_unavailable`** instead of being served
unlimited. Without it, a deployment that loses its binding silently becomes
unlimited.

It is **off by default** so local development and tests, which legitimately
declare no binding, are unaffected. `/health` and CORS preflight are never gated
on a limiter. Enable it in production only once the bindings exist.

503 rather than 429 is deliberate: the caller is not at fault and retrying will
not help.

---

## 7. Consumer checklist

Integrating a new project against CP-03:

1. Provision the project (`POST /v1/projects`), store its `projectId`.
2. Store the `mb_publishable_*` and `mb_secret_*` keys once, at creation. They
   are never returned again and only their hashes are stored.
3. Set the browser origin allowlist (`PUT /v1/projects/{id}/origins`).
4. **Read your quotas** (`GET /v1/projects/{id}/quotas`) and size the client
   against `effective`, not against the deployment defaults.
5. Handle 413 `request_body_too_large`, 413 `file_too_large`, 400
   `invalid_limit`, 429 `rate_limited`, 403 `origin_not_allowed`, and 503
   `rate_limiter_unavailable`.
6. On 429, back off. The bucket is per project per route class, so retrying the
   same route immediately will keep failing while another route may still work.
7. Use `hasMore`, not `nextAfter !== null`, to decide whether to page on.
8. On 401, do not retry with a different project's key — there is no such
   request. Re-check the credential.

A consumer must **never** place `mb_secret_*` or `mb_management_*` in a browser
bundle, and must never construct a project or database identifier of its own:
neither is accepted from a request.

---

## 8. Deliberately out of scope for CP-03

| Not provided | Why | Where it belongs |
| --- | --- | --- |
| Per-project record-count quota | Needs a `COUNT` over the D1 REST hop per write; ADR-0001 says round trips must be minimized, not assumed cheap | a scoped decision with measurements |
| Per-project storage-byte quota | Same cost problem; usage counters are observability | CP-07 |
| Per-project numeric request rate | The binding owns `limit`/`period`; a MiniBase-maintained counter costs a control-D1 write per request | a scoped decision, see §6 |
| Project-scoped management keys | The control plane is account-level by design; no IAM platform | `docs/SCALABILITY.md` item M, P3 |
| Row-level end-user authorization | MiniBase has no end-user identity on the data plane | separate design |
| A project schema version that adds a *column* | Would make the Worker write a column the live `interactive-kp` tenant does not have | CP-06 |

Nothing in CP-03 replaces D1, R2, the Worker, or the existing API contract. No
new project schema version is introduced, so a live tenant is unaffected until it
chooses to set a quota.

---

## 9. CP-04 query layer: what does *not* change

The CP-04 record query (`docs/DATA_API.md` §Query) is entirely inside the
existing isolation model, and every guarantee above still holds verbatim:

- the project is still resolved **only** from the key hash; no query parameter
  names a project, a database, or a collection outside that project's D1;
- filter, order, and select names are chosen by the server from a static
  allowlist — a caller's text never becomes SQL, and every value is bound;
- an unknown field, operator, order, select, or cursor is a deterministic 400
  **before** any project D1 or R2 is contacted;
- field selection shapes the response only; it cannot narrow a filter, the
  cursor, or an authorization check, and cannot name an internal column;
- a cursor is opaque, carries its own filter/order/collection digest, and is
  refused fail-closed if it does not match the request that presents it;
- per-project `maxPageSize`, the per-project rate bucket, the origin allowlist,
  and the identical-401 no-existence-leak rule all apply unchanged;
- one query is still one D1 REST round trip, so no tenant's query costs another
  tenant additional control-plane work.

Project schema v5 adds **indexes only** — no column — so a tenant that has not
run `schema/apply` keeps serving every CP-04 query with identical results.
`src/record-query.test.ts` covers the cross-project, injection, quota, and
publishable-key cases directly.
