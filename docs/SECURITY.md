# Security and production gates

MiniBase applies uniform no-store, CSP, framing, MIME, permissions, referrer,
and correlation headers. Rate-limit identities use only a SHA-256 data/control
key or Cloudflare-provided client IP; raw credentials are never used as binding
keys or logs.

The rate-limit Worker bindings are optional in local builds. A production launch
must remain blocked until the owner explicitly approves:

- the Cloudflare account/resource creation and any applicable cost;
- separate control, data, and file rate/period values — the CP-03 mechanism for
  this now exists (`RATE_LIMITER_CONTROL` / `RATE_LIMITER_DATA` /
  `RATE_LIMITER_FILES`, each with its own `limit` and `period`), but declaring a
  namespace still touches real Cloudflare resources;
- expected 429 behavior for each consuming application;
- monitoring and an emergency rollback/version procedure.

Until separate namespaces are approved, a single shared `RATE_LIMITER` binding
remains the fallback for every route class, which is the pre-CP-03 behaviour.
Setting `MB_RATE_LIMITER_REQUIRED="true"` makes a route whose binding cannot be
resolved fail closed with 503 `rate_limiter_unavailable` rather than serve
unlimited traffic; it is off by default so local builds and tests are unaffected.

The Cloudflare D1 API token remains a Worker secret. It must never appear in
client configuration, SDK bundles, logs, migration archives, or API responses.

`mb_publishable_*` is safe to expose only because it is restricted to
`data:read` and `files:read`. Browser write access is not equivalent to
authorization: `data:write`, `files:write`, and `project:admin` require a
backend-only `mb_secret_*` key. End-user writes require an authenticated,
row-level authorization layer rather than broader publishable-key scopes.

CP-05 `POST /v1/commands/records:upsert-many` has an additional route-level
secret-kind check in addition to its `data:write` scope check: a malformed or
legacy publishable-key row cannot gain command access. Its mandatory opaque
`Idempotency-Key` is capped at 100 characters and is only bound as a value; the
project marker stores a SHA-256 digest, never the raw header. The command has no
caller-selected SQL, table name, project/database address, or generic operation
field. One static v6 trigger reads fixed JSON paths from a validated canonical
payload and atomically applies its records with the marker. See
[`DATA_API.md`](DATA_API.md#commands-cp-05) for the replay/conflict contract.

Denied management and data-plane authentication attempts are written to the
control-D1 audit log with a reason and, when known, key/project IDs. Raw bearer
tokens are never included. Successful data authentication updates `last_used_at`
at most once per key per configured interval, without creating an audit event.

Since 2026-09-01 the D1 free tier hard-fails past its daily row-write limit, so a
control-plane write on every authenticated request would have capped the whole
deployment — every project together — at that limit. Throttling key-activity
writes removes that coupling. It does not weaken authorization: revocation,
expiry, project status, and scopes are re-checked from the row on every single
request.

Every audit row now carries `entity`, `entity_id`, and `correlation_id`. The
correlation ID is the `x-minibase-request-id` the caller already receives, so a
support report can be matched to the events it produced without storing request
payloads.

Every non-health request is limited first by route class and client IP. Requests
that carry a bearer credential are additionally limited by a SHA-256 credential
identity. Rotating arbitrary invalid bearer strings therefore cannot bypass the
shared IP ceiling, and raw credentials never become rate-limit keys.

Once a request is authenticated it is additionally limited by a **per-project**
bucket, `{route}:project:{projectId}`, consulted before the origin lookup — which
is itself a control-D1 read — so a tenant that has exhausted its ceiling stops
spending shared control-plane capacity at that point. This is what keeps one
project from consuming the account-wide D1 row quota every other project depends
on. The project ID comes from the authenticated principal, never from a request,
and has already passed the identity guard below, so it cannot inject a key
boundary or collide with another tenant's bucket.

Rate-limit denials write **no** audit row. A denial storm would otherwise consume
one control-D1 write per rejected request, spending the same daily quota the
limiter exists to protect.

## Fail-closed project context

Two values are interpolated rather than bound as parameters, because both are
addresses and not data: `projects.d1_database_id` becomes a segment of the
Cloudflare REST path, and `projects.id` becomes the R2 key prefix. Both come from
the control plane, so neither is attacker-controlled — but a hand-edited or
corrupted control row could otherwise redirect the data plane to another API path
or write an object outside its tenant prefix.

`isSafeIdentity` (`src/security.ts`) therefore requires `^[A-Za-z0-9-]{1,64}$` at
the single authentication choke point every data-plane request passes through.
Dots are excluded, so `..` cannot be expressed at all; `/`, `?`, `#`, `%`, and
whitespace are excluded, so no path or query boundary can be injected. Canonical
UUIDs always satisfy it. A row that fails is refused before any backend is
contacted.

Every project-context failure — unknown, revoked, or expired key, inactive
project, missing or malformed database UUID, insufficient scope — returns an
**identical** 401 `{"error":{"code":"unauthorized"}}`, so a probe cannot
enumerate which projects exist or which are misconfigured. The distinguishing
reason is written to the audit log as `metadata.reason`, with the CP-01
`correlation_id` joining it to the request ID the caller received. Operators can
diagnose; callers cannot enumerate.

Full contract, including per-project quotas:
[`PROJECT_ISOLATION.md`](PROJECT_ISOLATION.md).

Request ceilings are configurable per deployment and bounded by hard maxima; see
`docs/DATA_API.md`. An invalid override falls back to the default rather than
widening a limit.

Since CP-03 each ceiling can additionally be tightened **per project** through
`projects.quota_*`. The relationship is one-directional:
`HARD_LIMITS >= deployment ceiling >= project quota = enforced value`. A project
can be given a smaller allowance and can never be given a larger one — not through
the management endpoint, and not by editing the control D1 directly, because an
invalid stored value is ignored rather than applied. `keyActivityIntervalMs` is
deliberately excluded from the quota set: it sizes a control-D1 write budget
shared by every tenant, so a project raising it would raise the whole
deployment's write volume.
