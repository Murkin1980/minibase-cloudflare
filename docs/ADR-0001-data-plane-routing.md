# ADR-0001: Dynamic per-project D1 routing

Status: accepted for the free MVP  
Date: 2026-07-29

## Context

MiniBase must expose one public Worker endpoint while keeping one D1 database per
project. A normal D1 Worker binding is selected at deployment time and cannot be
constructed from a database UUID at request time.

Workers for Platforms can dynamically dispatch to Workers with project-specific
bindings, but it is a paid product. It is outside the approved MiniBase scope.

## Decision

The MVP data plane will:

1. authenticate `mb_publishable_*` or `mb_secret_*` against hashes in the control
   D1;
2. resolve the owning active project and its D1 UUID;
3. authorize a predefined data operation from the key scopes;
4. execute parameterized SQL through the Cloudflare D1 HTTP API;
5. return a bounded, normalized response.

The Cloudflare token remains a Worker secret. It is never accepted from or
returned to a client. The public API will not accept arbitrary SQL.

## Consequences

- Meets one-D1-per-project isolation and the single-endpoint requirement.
- Uses only Cloudflare services already in scope and requires no paid platform.
- Adds an HTTP hop compared with a native binding.
- Requires strict response limits, retry classification, audit metadata, and
  careful prevention of identifier injection.

## Rejected alternatives

- One shared D1 with `project_id`: violates the isolation requirement.
- One independently deployed Worker per project: violates the single deployment
  goal and adds script lifecycle overhead.
- Workers for Platforms: technically suitable, but paid and not approved.
- Durable Objects: do not solve dynamic D1 binding and are unnecessary without a
  realtime requirement.

## Revisit when

- Workers exposes a free dynamic D1 binding capability;
- measured HTTP API latency or limits make the MVP data plane unsuitable; or
- the owner separately approves Workers for Platforms.
