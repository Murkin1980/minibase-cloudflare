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

## Access session

```ts
const bootstrap = new MiniBaseClient({ baseUrl, key: publishableKey });
const { token, expiresAt } = await bootstrap.exchangeAccessSession();
const userClient = new MiniBaseClient({ baseUrl, key: token });

await userClient.put("progress", "lesson-1", { completed: true });
await userClient.endSession();
```

Cloudflare Access injects the assertion at the protected Worker boundary. Application JavaScript does not read, store or construct that assertion. Session tokens must remain in memory where practical and must never be committed or logged.

File downloads return the original streaming `Response`. Uploads accept a
`Blob`, forwarding its exact size and media type; file paths receive the same
traversal checks as the Worker.
