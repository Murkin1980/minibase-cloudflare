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
