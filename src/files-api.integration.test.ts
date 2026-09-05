import { afterEach, describe, expect, it, vi } from "vitest";
import "./test-harness";
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
      CONTROL_DB: { prepare() { throw new Error("unused"); }, async batch() { return []; } } as unknown as MiniBaseEnv["CONTROL_DB"],
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_D1_API_TOKEN: "token",
      FILES: {
        async head() { return null; },
        async get() { return null; },
        async put(key: string, value: unknown) {
          storedKey = key;
          storedBody = await new Response(value as ReadableStream).text();
          return { ...object, key } as unknown as R2Object;
        },
        async delete(key: string | string[]) { deleted.push(...(Array.isArray(key) ? key : [key])); },
        async list() { return { objects: [], truncated: false }; },
      } as unknown as MiniBaseEnv["FILES"],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as { sql?: string };
      const sql = body.sql ?? "";
      if (sql.includes("SELECT version FROM mb_schema_versions WHERE version = 7")) {
        return Response.json({ success: true, result: [{ success: true, results: [{ version: 7 }] }] });
      }
      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_files'")) {
        const sqlText = "CREATE TABLE mb_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT, etag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*')), uploaded_at TEXT, entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63)), entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128)))";
        return Response.json({ success: true, result: [{ success: true, results: [{ sql: sqlText }] }] });
      }
      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_artifacts'")) {
        const sqlText = "CREATE TABLE mb_artifacts (artifact_id TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, content_type TEXT, etag TEXT NOT NULL, checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'), uploaded_at TEXT NOT NULL, created_at TEXT NOT NULL, CHECK((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL)))";
        return Response.json({ success: true, result: [{ success: true, results: [{ sql: sqlText }] }] });
      }
      if (sql.startsWith("PRAGMA table_info(mb_files)")) {
        return Response.json({ success: true, result: [{ success: true, results: [
          { name: "path", type: "TEXT", notnull: 1, pk: 1 },
          { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "content_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "etag", type: "TEXT", notnull: 1, pk: 0 },
          { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "checksum_sha256", type: "TEXT", notnull: 0, pk: 0 },
          { name: "uploaded_at", type: "TEXT", notnull: 0, pk: 0 },
          { name: "entity_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "entity_id", type: "TEXT", notnull: 0, pk: 0 },
        ] }] });
      }
      if (sql.startsWith("PRAGMA table_info(mb_artifacts)")) {
        return Response.json({ success: true, result: [{ success: true, results: [
          { name: "artifact_id", type: "TEXT", notnull: 1, pk: 1 },
          { name: "storage_key", type: "TEXT", notnull: 1, pk: 0 },
          { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "content_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "etag", type: "TEXT", notnull: 1, pk: 0 },
          { name: "checksum_sha256", type: "TEXT", notnull: 1, pk: 0 },
          { name: "uploaded_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "entity_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "entity_id", type: "TEXT", notnull: 0, pk: 0 },
          { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        ] }] });
      }
      return Response.json({ success: true, result: [{ success: true, results: [] }] });
    })) as unknown as typeof fetch;
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
      CONTROL_DB: { prepare() { throw new Error("unused"); }, async batch() { return []; } } as unknown as MiniBaseEnv["CONTROL_DB"],
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_D1_API_TOKEN: "token",
      FILES: {
        async head() { return null; },
        async get() { return null; },
        async put(key: string, value: unknown) {
          // Consume the hashing stream so shaPromise resolves (production R2 does)
          if (value instanceof ReadableStream) await new Response(value as ReadableStream).text();
          return {
            key, size: 3, etag: "etag", httpEtag: "\"etag\"", uploaded: new Date(),
            writeHttpMetadata() {},
          } as unknown as R2Object;
        },
        async delete(key: string | string[]) { deleted.push(...(Array.isArray(key) ? key : [key])); },
        async list() { return { objects: [], truncated: false }; },
      } as unknown as MiniBaseEnv["FILES"],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}")) as { sql?: string };
      const sql = body.sql ?? "";
      if (sql.includes("SELECT version FROM mb_schema_versions WHERE version = 7")) {
        return Response.json({ success: true, result: [{ success: true, results: [{ version: 7 }] }] });
      }
      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_files'")) {
        const sqlText = "CREATE TABLE mb_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT, etag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*')), uploaded_at TEXT, entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63)), entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128)))";
        return Response.json({ success: true, result: [{ success: true, results: [{ sql: sqlText }] }] });
      }
      if (sql.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_artifacts'")) {
        const sqlText = "CREATE TABLE mb_artifacts (artifact_id TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, content_type TEXT, etag TEXT NOT NULL, checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'), uploaded_at TEXT NOT NULL, created_at TEXT NOT NULL, CHECK((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL)))";
        return Response.json({ success: true, result: [{ success: true, results: [{ sql: sqlText }] }] });
      }
      if (sql.startsWith("PRAGMA table_info(mb_files)")) {
        return Response.json({ success: true, result: [{ success: true, results: [
          { name: "path", type: "TEXT", notnull: 1, pk: 1 },
          { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "content_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "etag", type: "TEXT", notnull: 1, pk: 0 },
          { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "checksum_sha256", type: "TEXT", notnull: 0, pk: 0 },
          { name: "uploaded_at", type: "TEXT", notnull: 0, pk: 0 },
          { name: "entity_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "entity_id", type: "TEXT", notnull: 0, pk: 0 },
        ] }] });
      }
      if (sql.startsWith("PRAGMA table_info(mb_artifacts)")) {
        return Response.json({ success: true, result: [{ success: true, results: [
          { name: "artifact_id", type: "TEXT", notnull: 1, pk: 1 },
          { name: "storage_key", type: "TEXT", notnull: 1, pk: 0 },
          { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "content_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "etag", type: "TEXT", notnull: 1, pk: 0 },
          { name: "checksum_sha256", type: "TEXT", notnull: 1, pk: 0 },
          { name: "uploaded_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "entity_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "entity_id", type: "TEXT", notnull: 0, pk: 0 },
          { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        ] }] });
      }
      if (sql.includes("INSERT INTO mb_files")) {
        return Response.json({ success: false, errors: [{ message: "transport failed" }] }, { status: 500 });
      }
      return Response.json({ success: true, result: [{ success: true, results: [] }] });
    })) as unknown as typeof fetch;
    const request = new Request("https://minibase.test/v1/files/a.txt", {
      method: "PUT",
      headers: { "content-length": "3" },
      body: "abc",
    });
    await expect(uploadFile(env, principal, "a.txt", request)).rejects.toThrow("cloudflare_api_error");
    expect(deleted).toEqual(["project-a/a.txt"]);
  });
});
