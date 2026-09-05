import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataPrincipal, MiniBaseEnv, R2Object } from "./contracts";
import { uploadFile } from "./files-api";
import { DEFAULT_LIMITS } from "./limits";

const principal: DataPrincipal = {
  keyId: "key",
  projectId: "project-a",
  databaseId: "database-a",
  kind: "secret",
  scopes: ["project:admin"],
  // CP-03: no stored quota, so the project is served at the deployment ceilings.
  limits: DEFAULT_LIMITS,
};

afterEach(() => vi.unstubAllGlobals());

describe("file upload integration boundary", () => {
  it("streams to a project-prefixed R2 key and persists metadata", async () => {
    let storedKey = "";
    let storedBody = "";
    const deleted: string[] = [];
    const object = {
      key: "",
      size: 3,
      etag: "etag-1",
      httpEtag: "\"etag-1\"",
      uploaded: new Date(),
      writeHttpMetadata() {},
    } satisfies R2Object;
    const env: MiniBaseEnv = {
      CONTROL_DB: { prepare() { throw new Error("unused"); }, async batch() { return []; } },
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_D1_API_TOKEN: "token",
      FILES: {
        async get() { return null; },
        async put(key, value) {
          storedKey = key;
          storedBody = await new Response(value).text();
          return { ...object, key };
        },
        async delete(key) { deleted.push(...(Array.isArray(key) ? key : [key])); },
        async list() { return { objects: [], truncated: false }; },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: true,
      result: [{ success: true, results: [] }],
    })));
    const request = new Request("https://minibase.test/v1/files/docs/a.txt", {
      method: "PUT",
      headers: { "content-length": "3", "content-type": "text/plain" },
      body: "abc",
    });
    await expect(uploadFile(env, principal, "docs/a.txt", request)).resolves.toMatchObject({
      path: "docs/a.txt", size: 3, etag: "etag-1",
    });
    expect(storedKey).toBe("project-a/docs/a.txt");
    expect(storedBody).toBe("abc");
    expect(deleted).toEqual([]);
  });

  it("deletes the uploaded object when metadata persistence fails", async () => {
    const deleted: string[] = [];
    const env: MiniBaseEnv = {
      CONTROL_DB: { prepare() { throw new Error("unused"); }, async batch() { return []; } },
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_D1_API_TOKEN: "token",
      FILES: {
        async get() { return null; },
        async put(key) {
          return {
            key, size: 3, etag: "etag", httpEtag: "\"etag\"", uploaded: new Date(),
            writeHttpMetadata() {},
          };
        },
        async delete(key) { deleted.push(...(Array.isArray(key) ? key : [key])); },
        async list() { return { objects: [], truncated: false }; },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false, result: [] }, { status: 500 })));
    const request = new Request("https://minibase.test/v1/files/a.txt", {
      method: "PUT",
      headers: { "content-length": "3" },
      body: "abc",
    });
    await expect(uploadFile(env, principal, "a.txt", request)).rejects.toThrow("cloudflare_api_error");
    expect(deleted).toEqual(["project-a/a.txt"]);
  });
});
