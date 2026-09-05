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

`after` must be the previous page's `nextAfter`, unchanged. It is opaque and is
bound to the filter, order, and collection that produced it: reusing it with a
different query is a deterministic 400 `invalid_cursor`, not a wrong page. A
call that passes neither `filter` nor `order` behaves exactly as it did before
CP-04, cursor included.
