# MiniBase TypeScript client

The zero-dependency client in `src/client.ts` targets browsers, Workers, and
modern Node runtimes with `fetch`.

```ts
import { MiniBaseClient } from "./src/client";

const minibase = new MiniBaseClient({
  baseUrl: "https://your-approved-worker.example",
  key: "mb_publishable_...",
});

const page = await minibase.list<{ title: string }>("lessons", { limit: 25 });
await minibase.put("progress", "user:lesson", { completed: true });
await minibase.uploadFile("avatars/user.png", imageBlob);
const response = await minibase.downloadFile("avatars/user.png");
```

Frontend code may receive only a deliberately scoped `mb_publishable_*` key.
`mb_secret_*` belongs in a backend or Worker secret. The client rejects
`mb_management_*`; control-plane credentials and the Cloudflare API token must
never enter application bundles.

Non-local HTTP base URLs are rejected. API failures throw
`MiniBaseClientError` with stable `code` and numeric `status`.

File downloads return the original streaming `Response`. Uploads accept a
`Blob`, forwarding its exact size and media type; file paths receive the same
traversal checks as the Worker.

## Atomic records command (CP-05)

`MiniBaseClient` deliberately has **no** command method. A command needs an
explicit server-side `MiniBaseSecretClient` constructed with an
`mb_secret_*`-shaped key, so TypeScript cannot accidentally offer it to a client
built with a publishable key:

```ts
import { MiniBaseSecretClient } from "./src/client";

const serverMiniBase = new MiniBaseSecretClient({
  baseUrl: "https://your-approved-worker.example",
  key: process.env.MINIBASE_SECRET_KEY as `mb_secret_${string}`,
});

const result = await serverMiniBase.upsertMany([
  { collection: "tasks", id: "task-123", data: { schemaVersion: 1, status: "created" } },
  { collection: "task_events", id: "event-456", data: { schemaVersion: 1, taskId: "task-123" } },
], "request-unique-key");
// result.replayed is false for a new command and true for an identical retry.
```

`upsertMany(operations, idempotencyKey)` requires 1…hard-maximum distinct
targets, safe non-internal collection names, safe record IDs, object data, and a
non-empty key no longer than 100 characters before it invokes `fetch`. The
Worker enforces the possibly smaller effective project `maxBulkRecords` quota
and remains the authority for all validation.

The SDK sends exactly one `POST /v1/commands/records:upsert-many` request with
`Idempotency-Key`. Keep that key stable when retrying the same normalized
operation sequence. An identical retry returns the stored result with
`replayed: true`; a changed payload under the same key throws
`MiniBaseClientError` with `code: "idempotency_conflict"` and status 409. Never
send a secret client or its key to a browser. The full server contract, including
schema-v6 readiness, is in [`DATA_API.md`](DATA_API.md#commands-cp-05).

## Querying records (CP-04)

`list()` accepts the CP-04 query options, typed against the server's allowlists
so a request MiniBase would reject with 400 does not compile — and is refused
locally before a request is made, for untyped callers.

```ts
const page = await minibase.list<{ text: string }>("tutor_notes", {
  filter: { schemaVersion: { eq: 1 }, updatedAt: { gte: lastSyncedAt } },
  order: { field: "updatedAt", direction: "desc" },
  select: ["id", "data", "updatedAt"],
  limit: 50,
});

if (page.hasMore) {
  const next = await minibase.list("tutor_notes", {
    filter: { schemaVersion: { eq: 1 }, updatedAt: { gte: lastSyncedAt } },
    order: { field: "updatedAt", direction: "desc" },
    limit: 50,
    after: page.nextAfter!,   // opaque — pass back unmodified
  });
}
```

Supported filters, orders, and select fields are exported as `filterOperators`,
`orderFieldNames`, and `selectFieldNames`, and are asserted in
`src/client.test.ts` to match the server contract in `src/record-query.ts`
exactly. See [`DATA_API.md`](DATA_API.md) §Query for the wire format.

`after` must be the previous page's `nextAfter`, unchanged. It is opaque and
carries a query-consistency digest of the filter, order, and collection that
produced it: reusing it with a different query is a deterministic 400
`invalid_cursor`, not a wrong page. The digest is not a signature and the cursor
is not tamper-proof — it guards against accidental misuse, not an attacker.

Timestamp filter values (`createdAt`, `updatedAt`) must carry an explicit
timezone and are normalized to canonical UTC server-side, so `new Date(...).toISOString()`
is always a safe thing to send. A
call that passes neither `filter` nor `order` behaves exactly as it did before
CP-04, cursor included.
