import { describe, expect, it, vi } from "vitest";
import { MiniBaseClient, MiniBaseClientError } from "./client";

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
