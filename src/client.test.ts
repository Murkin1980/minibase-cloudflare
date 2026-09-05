import { describe, expect, it, vi } from "vitest";
import {
  filterOperators,
  MiniBaseClient,
  MiniBaseClientError,
  MiniBaseSecretClient,
  type MiniBaseSecretClientOptions,
  orderFieldNames,
  selectFieldNames,
} from "./client";
import { recordQueryContract } from "./record-query";

// Compile-time capability boundary: callers with the ordinary/public client
// cannot discover the command member, and a publishable-shaped key cannot
// construct the secret command client options. This helper is intentionally not
// called; `npm run typecheck` verifies the two expected errors.
function assertCommandClientTypeBoundary(): void {
  const publishableClient = new MiniBaseClient({
    baseUrl: "https://minibase.example",
    key: "mb_publishable_browser-only",
  });
  // @ts-expect-error commands are deliberately absent from MiniBaseClient
  publishableClient.upsertMany([], "key");
  const invalidSecretOptions: MiniBaseSecretClientOptions = {
    baseUrl: "https://minibase.example",
    // @ts-expect-error only mb_secret_* key strings satisfy this option shape
    key: "mb_publishable_browser-only",
  };
  void invalidSecretOptions;
}
void assertCommandClientTypeBoundary;

describe("MiniBase client", () => {
  it("sends an authenticated encoded records request", async () => {
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      records: [],
      nextAfter: null,
    }));
    const client = new MiniBaseClient({
      baseUrl: "https://minibase.example/",
      key: "mb_publishable_test-client",
      fetch: requestFetch,
    });
    await expect(client.list("lesson_items", { limit: 25, after: "item:1" }))
      .resolves.toEqual({ records: [], nextAfter: null });
    expect(requestFetch).toHaveBeenCalledWith(
      "https://minibase.example/v1/data/lesson_items?limit=25&after=item%3A1",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer mb_publishable_test-client" }),
      }),
    );
  });

  it("binds the native fetch to its global context", async () => {
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json({ records: [], nextAfter: null }));
    });
    const client = new MiniBaseClient({
      baseUrl: "https://minibase.example",
      key: "mb_publishable_test-client",
    });

    await client.list("lesson_items");

    expect(nativeFetch).toHaveBeenCalledOnce();
    nativeFetch.mockRestore();
  });

  it("serializes writes and supports empty delete responses", async () => {
    const requestFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "a", data: { title: "A" }, updatedAt: "now" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new MiniBaseClient({
      baseUrl: "http://localhost:8787",
      key: "mb_secret_backend-only",
      fetch: requestFetch,
    });
    await client.put("lessons", "a", { title: "A" });
    await expect(client.delete("lessons", "a")).resolves.toBeUndefined();
    expect(requestFetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: '{"title":"A"}',
      headers: expect.objectContaining({ "content-type": "application/json" }),
    }));
  });

  it("keeps records:upsert-many on the explicit secret-only server-side client", async () => {
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      commandId: "command-123",
      status: "applied",
      operationCount: 2,
      records: [{ collection: "tasks", id: "task-1" }, { collection: "task_events", id: "event-1" }],
      replayed: false,
    }));
    const client = new MiniBaseSecretClient({
      baseUrl: "https://minibase.example",
      key: "mb_secret_server-only",
      fetch: requestFetch,
    });
    await expect(client.upsertMany([
      { collection: "tasks", id: "task-1", data: { status: "created" } },
      { collection: "task_events", id: "event-1", data: { taskId: "task-1" } },
    ], "command-key")).resolves.toEqual(expect.objectContaining({ replayed: false }));
    expect(requestFetch).toHaveBeenCalledWith(
      "https://minibase.example/v1/commands/records:upsert-many",
      expect.objectContaining({
        method: "POST",
        body: '{"operations":[{"collection":"tasks","id":"task-1","data":{"status":"created"}},{"collection":"task_events","id":"event-1","data":{"taskId":"task-1"}}]}',
        headers: expect.objectContaining({
          authorization: "Bearer mb_secret_server-only",
          "content-type": "application/json",
          "idempotency-key": "command-key",
        }),
      }),
    );

    expect(() => client.upsertMany([], "command-key")).toThrow("invalid_command");
    expect(() => client.upsertMany([
      { collection: "tasks", id: "task-1", data: {} },
      { collection: "tasks", id: "task-1", data: {} },
    ], "command-key")).toThrow("invalid_command");
    expect(() => client.upsertMany([{ collection: "mb_commands", id: "marker", data: {} }], "command-key"))
      .toThrow("invalid_collection");
    expect(() => client.upsertMany([{ collection: "tasks", id: "task-2", data: {} }], ""))
      .toThrow("invalid_idempotency_key");
    expect(() => new MiniBaseSecretClient({
      baseUrl: "https://minibase.example",
      key: "mb_publishable_not-secret" as never,
    })).toThrow("invalid_secret_client_key");
  });

  it("rejects management keys, insecure origins, unsafe paths, and API errors", async () => {
    expect(() => new MiniBaseClient({
      baseUrl: "https://minibase.example",
      key: "mb_management_never-in-sdk",
    })).toThrow("invalid_client_key");
    expect(() => new MiniBaseClient({
      baseUrl: "http://minibase.example",
      key: "mb_publishable_test",
    })).toThrow("insecure_base_url");
    const client = new MiniBaseClient({
      baseUrl: "https://minibase.example",
      key: "mb_publishable_test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(
        { error: { code: "record_not_found" } },
        { status: 404 },
      )),
    });
    expect(() => client.get("../bad", "id")).toThrow("invalid_collection");
    await expect(client.get("lessons", "missing")).rejects.toEqual(
      expect.objectContaining<Partial<MiniBaseClientError>>({ code: "record_not_found", status: 404 }),
    );
  });

  it("streams file responses and sends explicit upload metadata", async () => {
    const download = new Response("hello", { headers: { "content-type": "text/plain" } });
    const requestFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(download)
      .mockResolvedValueOnce(Response.json({
        path: "docs/a.txt", size: 5, contentType: "text/plain", etag: "x", updatedAt: "now",
      }));
    const client = new MiniBaseClient({
      baseUrl: "https://minibase.example",
      key: "mb_secret_files",
      fetch: requestFetch,
    });
    await expect(client.downloadFile("docs/a.txt")).resolves.toBe(download);
    await client.uploadFile("docs/a.txt", new Blob(["hello"], { type: "text/plain" }));
    expect(requestFetch.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ "content-length": "5", "content-type": "text/plain" }),
    }));
    expect(() => client.deleteFile("../escape")).toThrow("invalid_file_path");
  });
});

describe("MiniBase client CP-04 query options", () => {
  function stub() {
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ records: [], nextAfter: null, hasMore: false }),
    );
    const client = new MiniBaseClient({
      baseUrl: "https://minibase.example",
      key: "mb_publishable_test-client",
      fetch: requestFetch,
    });
    return { client, requestFetch, url: () => String(requestFetch.mock.calls.at(-1)?.[0]) };
  }

  it("leaves a pre-CP-04 call byte-identical", async () => {
    const { client, url } = stub();
    await client.list("lessons", { limit: 10, after: "rec-1" });
    expect(url()).toBe("https://minibase.example/v1/data/lessons?limit=10&after=rec-1");
  });

  it("serializes filter, order, and select into the server's query shape", async () => {
    const { client, url } = stub();
    await client.list("lessons", {
      filter: { schemaVersion: { eq: 2 }, updatedAt: { gte: "2026-09-01T00:00:00.000Z" } },
      order: { field: "updatedAt", direction: "desc" },
      select: ["id", "updatedAt"],
      limit: 25,
    });
    const parsed = new URL(url());
    expect(parsed.searchParams.get("filter[schemaVersion]")).toBe("2");
    expect(parsed.searchParams.get("filter[updatedAt.gte]")).toBe("2026-09-01T00:00:00.000Z");
    expect(parsed.searchParams.get("order")).toBe("updatedAt.desc");
    expect(parsed.searchParams.get("select")).toBe("id,updatedAt");
    expect(parsed.searchParams.get("limit")).toBe("25");
  });

  it("defaults the order direction to ascending", async () => {
    const { client, url } = stub();
    await client.list("lessons", { order: { field: "createdAt" } });
    expect(new URL(url()).searchParams.get("order")).toBe("createdAt.asc");
  });

  it("round-trips an opaque CP-04 cursor without validating it as a record ID", async () => {
    const { client, url } = stub();
    const cursor = "mbq1.WyIxYWJjIiwiMjAyNiIsInJlYy0xIl0";
    await client.list("lessons", { order: { field: "updatedAt" }, after: cursor });
    expect(new URL(url()).searchParams.get("after")).toBe(cursor);
  });

  it("refuses locally anything the server would reject with 400", () => {
    const { client, requestFetch } = stub();
    // Typed away at compile time; asserted at runtime for untyped callers.
    expect(() => client.list("lessons", { filter: { schemaVersion: { gt: 1 } } as never }))
      .toThrow("invalid_operator");
    expect(() => client.list("lessons", { order: { field: "data" as never } }))
      .toThrow("invalid_order");
    expect(() => client.list("lessons", { select: ["collection" as never] }))
      .toThrow("invalid_select");
    expect(() => client.list("lessons", { select: [] })).toThrow("invalid_select");
    expect(() => client.list("lessons", { order: { field: "id" }, after: "not a cursor!" }))
      .toThrow("invalid_cursor");
    expect(() => client.list("lessons", { limit: 0 })).toThrow("invalid_limit");
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("mirrors the server allowlists exactly", () => {
    expect(Object.keys(filterOperators).sort()).toEqual(Object.keys(recordQueryContract.filters).sort());
    for (const [field, operators] of Object.entries(recordQueryContract.filters)) {
      expect([...filterOperators[field as keyof typeof filterOperators]]).toEqual(operators);
    }
    expect([...orderFieldNames]).toEqual(recordQueryContract.orders);
    expect([...selectFieldNames]).toEqual(recordQueryContract.select);
  });
});
