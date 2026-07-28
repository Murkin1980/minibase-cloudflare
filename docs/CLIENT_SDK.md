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
```

Frontend code may receive only a deliberately scoped `mb_publishable_*` key.
`mb_secret_*` belongs in a backend or Worker secret. The client rejects
`mb_management_*`; control-plane credentials and the Cloudflare API token must
never enter application bundles.

Non-local HTTP base URLs are rejected. API failures throw
`MiniBaseClientError` with stable `code` and numeric `status`.
