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

## End-user identity boundary

- Access JWT verification requires RS256, expected issuer/audience, non-expired `exp`, non-empty `sub`, matching `kid` and valid signature.
- Only the project-bound SHA-256 of `sub` is stored; email and raw Access subject are not persisted.
- Session token values are returned once and stored only as SHA-256 hashes.
- Sessions expire after eight hours and may be explicitly revoked.
- Records and files are owner-scoped by the hashed subject; public/project keys do not silently acquire user semantics.
- Production deployment is blocked until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set to verified, non-placeholder values and the Worker route is protected by Cloudflare Access.
