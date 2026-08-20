# Security and production gates

MiniBase applies uniform no-store, CSP, framing, MIME, permissions, referrer,
and correlation headers. Rate-limit identities use only a SHA-256 data/control
key or Cloudflare-provided client IP; raw credentials are never used as binding
keys or logs.

The `RATE_LIMITER` Worker binding is optional in local builds. A production
launch must remain blocked until the owner explicitly approves:

- the Cloudflare account/resource creation and any applicable cost;
- separate control, data, and file rate/period values;
- expected 429 behavior for each consuming application;
- monitoring and an emergency rollback/version procedure.

The Cloudflare D1 API token remains a Worker secret. It must never appear in
client configuration, SDK bundles, logs, migration archives, or API responses.

`mb_publishable_*` is safe to expose only because it is restricted to
`data:read` and `files:read`. Browser write access is not equivalent to
authorization: `data:write`, `files:write`, and `project:admin` require a
backend-only `mb_secret_*` key. End-user writes require an authenticated,
row-level authorization layer rather than broader publishable-key scopes.

Denied management and data-plane authentication attempts are written to the
control-D1 audit log with a reason and, when known, key/project IDs. Raw bearer
tokens are never included. Successful data authentication updates `last_used_at`
without creating a high-volume audit event.

Every non-health request is limited first by route class and client IP. Requests
that carry a bearer credential are additionally limited by a SHA-256 credential
identity. Rotating arbitrary invalid bearer strings therefore cannot bypass the
shared IP ceiling, and raw credentials never become rate-limit keys.
