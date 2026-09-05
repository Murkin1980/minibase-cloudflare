import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { DataPrincipal, MiniBaseEnv, R2Object } from "./contracts";
import { uploadOriginalArtifact } from "./artifact-api";
import { projectSchemaMigrations } from "./project-schema";
import { DEFAULT_LIMITS } from "./limits";
import "./test-harness";
declare const process: { on: (e: string, h: (r: unknown) => void) => void; off: (e: string, h: (r: unknown) => void) => void };

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
let env: MiniBaseEnv;
let failNextInsert = false;

const databaseId = "r2-artifact-db";
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const principal: DataPrincipal = {
  keyId: "test-key",
  projectId,
  databaseId,
  kind: "secret",
  scopes: ["project:admin"],
  limits: DEFAULT_LIMITS,
};
const otherProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherPrincipal: DataPrincipal = {
  keyId: "other-key",
  projectId: otherProjectId,
  databaseId: "other-db",
  kind: "secret",
  scopes: ["project:admin"],
  limits: DEFAULT_LIMITS,
};

// Buffered wrapper for Miniflare's R2 to satisfy FixedLengthStream requirement
// while preserving conditional atomicity. For early-cancel test we use a separate mock that does not buffer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function wrapR2WithBufferedPut(rawBucket: any): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalPut = (rawBucket as any).put.bind(rawBucket);
  const wrapped = Object.create(rawBucket) as typeof bucket;
  (wrapped as unknown as Record<string, unknown>).put = async (
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string | null,
    options?: Parameters<typeof rawBucket.put>[2],
  ) => {
    if (value instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = (value as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (chunk) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as unknown as ArrayBuffer));
        }
      } catch (e) {
        try { reader.releaseLock(); } catch (_e) { void _e; }
        throw e;
      }
      const total = chunks.reduce((a, b) => a + b.byteLength, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return originalPut(key, buf, options as never);
    }
    return originalPut(key, value as never, options as never);
  };
  return wrapped;
}

// Mock R2 that does production-like early conditional reject without buffering,
// and properly cancels the stream to test hashing cancellation.
function createEarlyCancelR2(): { bucket: MiniBaseEnv["FILES"]; store: Map<string, string> } {
  const store = new Map<string, string>();
  const bucket = {
    async get(key: string) {
      const body = store.get(key);
      if (body === undefined) return null;
      const obj = {
        key,
        size: new TextEncoder().encode(body).byteLength,
        etag: `etag-${key}`,
        httpEtag: `"etag-${key}"`,
        body: new Response(body).body ?? undefined,
      } as unknown as R2Object & { text: () => Promise<string> };
      // Add text() for test convenience
      (obj as unknown as Record<string, unknown>).text = () => Promise.resolve(body);
      return obj;
    },
    async head(key: string) {
      const body = store.get(key);
      if (body === undefined) return null;
      return { key, size: new TextEncoder().encode(body).byteLength, etag: `etag-${key}`, httpEtag: `"etag-${key}"` } as unknown as R2Object;
    },
    async put(
      key: string,
      value: ReadableStream<Uint8Array> | string | ArrayBuffer | null,
      options?: { onlyIf?: { etagDoesNotMatch?: string } },
    ) {
      const isConditional = options?.onlyIf?.etagDoesNotMatch === "*";
      if (isConditional && store.has(key)) {
        // Production-like early reject: do not consume stream, cancel it
        if (value instanceof ReadableStream) {
          try {
            // Cancel the readable side via reader
            const reader = value.getReader();
            await reader.cancel(new Error("r2_conditional_412"));
          } catch (_e) { void _e; }
          try {
            // Also try direct cancel if available
            await (value as unknown as { cancel?: (r: unknown) => Promise<void> }).cancel?.(new Error("r2_conditional_412"));
          } catch (_e) { void _e; }
        }
        return null as unknown as R2Object;
      }
      let body: string;
      if (value instanceof ReadableStream) {
        body = await new Response(value).text();
      } else if (typeof value === "string") body = value;
      else if (value instanceof ArrayBuffer) body = new TextDecoder().decode(value);
      else if (value === null) body = "";
      else body = String(value);
      store.set(key, body);
      return { key, size: new TextEncoder().encode(body).byteLength, etag: `etag-${key}`, httpEtag: `"etag-${key}"` } as unknown as R2Object;
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      const prefix = options?.prefix ?? "";
      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = options?.cursor ? allKeys.findIndex((k) => k > options.cursor!) : 0;
      const slice = allKeys.slice(start >= 0 ? start : 0, (start >= 0 ? start : 0) + (options?.limit ?? 1000));
      const objects = slice.map((key) => ({ key, size: new TextEncoder().encode(store.get(key)!).byteLength, etag: `etag-${key}`, httpEtag: `"etag-${key}"` } as unknown as R2Object));
      return { objects, truncated: false, cursor: undefined, delimitedPrefixes: [] } as unknown as ReturnType<MiniBaseEnv["FILES"]["list"]>;
    },
  } as unknown as MiniBaseEnv["FILES"];
  return { bucket, store };
}

async function setupEnvWithRealR2AndD1(options: { partialAlters?: number } = {}) {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-07-28",
    d1Databases: { PROJECT_DB: databaseId, OTHER_DB: "other-db" },
    r2Buckets: ["FILES"],
    cf: false,
  });
  db = await mf.getD1Database("PROJECT_DB");
  const rawBucket = await mf.getR2Bucket("FILES");
  bucket = await wrapR2WithBufferedPut(rawBucket);
  const otherDb = await mf.getD1Database("OTHER_DB");
  for (const mig of projectSchemaMigrations.filter((m) => m.version <= 6)) {
    for (const sql of mig.statements) {
      await db.prepare(sql).run();
      await otherDb.prepare(sql).run();
    }
  }
  if (options.partialAlters !== undefined) {
    const v7 = projectSchemaMigrations.find((m) => m.version === 7)!;
    const alters = v7.statements.slice(0, 4);
    for (let i = 0; i < options.partialAlters; i++) {
      await db.prepare(alters[i]).run();
    }
  } else {
    const v7 = projectSchemaMigrations.find((m) => m.version === 7)!;
    for (const sql of v7.statements) {
      await db.prepare(sql).run();
      await otherDb.prepare(sql).run();
    }
  }

  failNextInsert = false;

  env = {
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_D1_API_TOKEN: "test-token",
    CONTROL_DB: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      prepare(_sql: string) {
        return {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          bind(..._args: unknown[]) {
            return {
              async first() { return { id: projectId, slug: "test", d1_database_id: databaseId, data_schema_version: 6 } as unknown as never; },
              async run() { return { success: true } as never; },
              async all() { return { results: [] } as never; },
            };
          },
        } as unknown as MiniBaseEnv["CONTROL_DB"] extends { prepare: infer P } ? P : never;
      },
      batch: async () => [],
    } as unknown as MiniBaseEnv["CONTROL_DB"],
    FILES: bucket as unknown as MiniBaseEnv["FILES"],
  } as unknown as MiniBaseEnv;

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(`/d1/database/${databaseId}/query`) && !url.includes(`/d1/database/other-db/query`)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).__real_fetch ? await (globalThis as any).__real_fetch(input, init) : await fetch(input as Request, init);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
    if (failNextInsert && body.sql.includes("INSERT INTO mb_artifacts")) {
      failNextInsert = false;
      return Response.json({ success: false, errors: [{ message: "transport failed" }] }, { status: 500 });
    }
    try {
      const targetDb = url.includes("other-db") ? otherDb : db;
      const result = await targetDb.prepare(body.sql).bind(...(body.params ?? []) as never[]).all();
      return Response.json({ success: true, result: [result] });
    } catch (e) {
      const msg = (e as Error).message;
      return Response.json({ success: false, errors: [{ message: msg }] }, { status: 400 });
    }
  });
  if (!(globalThis as unknown as Record<string, unknown>).__real_fetch) {
    (globalThis as unknown as Record<string, unknown>).__real_fetch = fetch;
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await mf?.dispose();
});

describe("real Miniflare R2 atomicity — artifact immutable", () => {
  beforeEach(async () => {
    await setupEnvWithRealR2AndD1();
  });

  it("concurrent identical artifact PUT → exactly one 201 and one 409, winner bytes retained", async () => {
    const body = "identical-body";
    const mkReq = () => new Request("https://test/v1/artifacts/originals/concurrent-identical", {
      method: "PUT",
      headers: { "content-length": String(body.length), "content-type": "text/plain" },
      body,
      // @ts-expect-error duplex required for Request with body in Node
      duplex: "half",
    });
    const [r1, r2] = await Promise.all([
      uploadOriginalArtifact(env, principal, "concurrent-identical", mkReq()).then((v) => ({ ok: true as const, value: v })).catch((e) => ({ ok: false as const, error: e as Error })),
      uploadOriginalArtifact(env, principal, "concurrent-identical", mkReq()).then((v) => ({ ok: true as const, value: v })).catch((e) => ({ ok: false as const, error: e as Error })),
    ]);
    const okCount = [r1, r2].filter((r) => r.ok).length;
    const failCount = [r1, r2].filter((r) => !r.ok && (r as { error: Error }).error.message === "artifact_already_exists").length;
    expect(okCount).toBe(1);
    expect(failCount).toBe(1);
    const winner = [r1, r2].find((r) => r.ok) as { ok: true; value: { checksumSha256: string; size: number } };
    const expectedSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(winner.value.checksumSha256).toBe(expectedSha);
    expect(winner.value.size).toBe(body.length);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/concurrent-identical`);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe(body);
    const rows = await db.prepare("SELECT artifact_id, checksum_sha256 FROM mb_artifacts WHERE artifact_id = ?").bind("concurrent-identical").all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as { checksum_sha256: string }).checksum_sha256).toBe(expectedSha);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (bucket as any).get(`${projectId}/.mb_artifacts/originals/concurrent-identical`)).not.toBeNull();
  });

  it("concurrent different-body artifact PUT → exactly one 201, winner bytes not overwritten", async () => {
    const bodyA = "winner-body-A";
    const bodyB = "loser-body-B-different-longer";
    const mkReq = (body: string) => new Request("https://test/v1/artifacts/originals/concurrent-diff", {
      method: "PUT",
      headers: { "content-length": String(body.length), "content-type": "text/plain" },
      body,
      // @ts-expect-error duplex required for Request with body in Node
      duplex: "half",
    });
    const [r1, r2] = await Promise.all([
      uploadOriginalArtifact(env, principal, "concurrent-diff", mkReq(bodyA)).then((v) => ({ ok: true as const, body: bodyA, value: v })).catch((e) => ({ ok: false as const, body: bodyA, error: e as Error })),
      uploadOriginalArtifact(env, principal, "concurrent-diff", mkReq(bodyB)).then((v) => ({ ok: true as const, body: bodyB, value: v })).catch((e) => ({ ok: false as const, body: bodyB, error: e as Error })),
    ]);
    const ok = [r1, r2].filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    const winnerBody = (ok[0] as { body: string }).body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/concurrent-diff`);
    expect(await obj!.text()).toBe(winnerBody);
  });

  it("loser does not delete winner object", async () => {
    const body = "winner-keep";
    const req1 = new Request("https://test", { method: "PUT", headers: { "content-length": String(body.length) }, body, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    await uploadOriginalArtifact(env, principal, "no-delete-test", req1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objBefore = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/no-delete-test`);
    expect(objBefore).not.toBeNull();
    const req2 = new Request("https://test", { method: "PUT", headers: { "content-length": "3" }, body: "bad", // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    await expect(uploadOriginalArtifact(env, principal, "no-delete-test", req2)).rejects.toThrow("artifact_already_exists");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objAfter = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/no-delete-test`);
    expect(objAfter).not.toBeNull();
    expect(await objAfter!.text()).toBe(body);
  });

  it("D1 failure after R2 leaves orphan, retry gets 409", async () => {
    failNextInsert = true;
    const body = "orphan-body";
    const req = new Request("https://test", { method: "PUT", headers: { "content-length": String(body.length) }, body, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    await expect(uploadOriginalArtifact(env, principal, "orphan-art", req)).rejects.toThrow("cloudflare_api_error");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orphan = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/orphan-art`);
    expect(orphan).not.toBeNull();
    expect(await orphan!.text()).toBe(body);
    const rows = await db.prepare("SELECT * FROM mb_artifacts WHERE artifact_id = ?").bind("orphan-art").all();
    expect(rows.results).toHaveLength(0);
    const retryReq = new Request("https://test", { method: "PUT", headers: { "content-length": "3" }, body: "xyz", // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    await expect(uploadOriginalArtifact(env, principal, "orphan-art", retryReq)).rejects.toThrow("artifact_already_exists");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const still = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/orphan-art`);
    expect(await still!.text()).toBe(body);
  });

  it("partial v7 does zero R2 PUT", async () => {
    await mf.dispose();
    vi.unstubAllGlobals();
    await setupEnvWithRealR2AndD1({ partialAlters: 2 });
    const body = "should-not-put";
    const req = new Request("https://test", { method: "PUT", headers: { "content-length": String(body.length) }, body, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    await expect(uploadOriginalArtifact(env, principal, "partial-test", req)).rejects.toThrow("file_schema_not_ready");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/partial-test`);
    expect(obj).toBeNull();
    try {
      const rows = await db.prepare("SELECT * FROM mb_artifacts WHERE artifact_id = ?").bind("partial-test").all();
      expect(rows.results).toHaveLength(0);
    } catch (e) {
      expect(String(e)).toMatch(/no such table/);
    }
  });

  it("cross-project same artifactId isolation", async () => {
    const bodyA = "project-a-body";
    const bodyB = "project-b-body";
    const reqA = new Request("https://test", { method: "PUT", headers: { "content-length": String(bodyA.length) }, body: bodyA, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    const reqB = new Request("https://test", { method: "PUT", headers: { "content-length": String(bodyB.length) }, body: bodyB, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    const resA = await uploadOriginalArtifact(env, principal, "shared-id", reqA);
    expect(resA.artifactId).toBe("shared-id");
    const otherEnv = { ...env } as MiniBaseEnv;
    const resB = await uploadOriginalArtifact(otherEnv, otherPrincipal, "shared-id", reqB);
    expect(resB.artifactId).toBe("shared-id");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objA = await (bucket as any).get(`${projectId}/.mb_artifacts/originals/shared-id`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objB = await (bucket as any).get(`${otherProjectId}/.mb_artifacts/originals/shared-id`);
    expect(await objA!.text()).toBe(bodyA);
    expect(await objB!.text()).toBe(bodyB);
  });

  it("production-like early conditional reject without buffering — hash promise completes", async () => {
    // Use a mock R2 that does early 412 without consuming stream, to prove file-hash cancel works
    const { bucket: earlyBucket } = createEarlyCancelR2();
    const earlyEnv = { ...env, FILES: earlyBucket } as MiniBaseEnv;
    // First, create the object via valid PUT
    const body = "early-cancel-body";
    const req1 = new Request("https://test", { method: "PUT", headers: { "content-length": String(body.length) }, body, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    const res1 = await uploadOriginalArtifact(earlyEnv, principal, "early-cancel-id", req1);
    expect(res1.artifactId).toBe("early-cancel-id");
    // Second PUT on same ID should get 409 via early reject, and hashing stream should be cancelled but shaPromise must not hang
    const body2 = "second-body-that-will-be-cancelled";
    const req2 = new Request("https://test", { method: "PUT", headers: { "content-length": String(body2.length) }, body: body2, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    // Capture unhandledRejection
    const unhandled: unknown[] = [];
    const handler = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", handler);
    try {
      await expect(uploadOriginalArtifact(earlyEnv, principal, "early-cancel-id", req2)).rejects.toThrow("artifact_already_exists");
      // Allow microtasks to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveLength(0);
      // Verify that original object still exists and not deleted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = await (earlyBucket as any).get(`${projectId}/.mb_artifacts/originals/early-cancel-id`);
      expect(obj).not.toBeNull();
      expect(await (obj as unknown as { text: () => Promise<string> }).text()).toBe(body);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("concurrent oversized vs valid on same artifactId — valid wins without leaving both without object", async () => {
    const validBody = "valid";
    const tinyLimits = { ...DEFAULT_LIMITS, maxFileBytes: 10 };
    const tinyPrincipal = { ...principal, limits: tinyLimits } as DataPrincipal;
    const oversizedBody = "x".repeat(20); // 20 > 10, but header lies as 5
    const artifactId = "race-oversized-valid-same-key";
    const validReq = new Request("https://test", { method: "PUT", headers: { "content-length": String(validBody.length), "content-type": "text/plain" }, body: validBody, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });
    const oversizedReq = new Request("https://test", { method: "PUT", headers: { "content-length": "5", "content-type": "text/plain" }, body: oversizedBody, // @ts-expect-error duplex required for Request with body in Node
      duplex: "half" });

    // Use early-cancel mock for this race to ensure production-like behavior without buffering
    const { bucket: raceBucket } = createEarlyCancelR2();
    const raceEnv = { ...env, FILES: raceBucket } as MiniBaseEnv;

    const [rValid, rOversized] = await Promise.allSettled([
      uploadOriginalArtifact(raceEnv, principal, artifactId, validReq),
      uploadOriginalArtifact(raceEnv, tinyPrincipal, artifactId, oversizedReq, tinyLimits),
    ]);

    // With new file-hash that errors on overflow before R2 completes, oversized should get file_too_large without creating object,
    // valid should succeed. They should not both fail leaving empty.
    const validResult = rValid.status === "fulfilled" ? (rValid as PromiseFulfilledResult<Awaited<ReturnType<typeof uploadOriginalArtifact>>>).value : null;
    const oversizedError = rOversized.status === "rejected" ? (rOversized as PromiseRejectedResult).reason as Error : null;

    // At least one should have succeeded, and if valid succeeded, oversized must be file_too_large
    // If valid lost due to race (got 409), then oversized must have been file_too_large and object should still not be empty after retry
    // In either case, final object should exist (valid) or be file_too_large with no object, but not both 409 leaving empty
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = await (raceBucket as any).get(`${projectId}/.mb_artifacts/originals/${artifactId}`);
    if (validResult) {
      expect(validResult.artifactId).toBe(artifactId);
      // Oversized should be file_too_large, but if valid won race before oversized overflow, oversized gets 409 which is also acceptable per spec (409 precedence)
      expect(["file_too_large", "artifact_already_exists"]).toContain(oversizedError?.message);
      expect(obj).not.toBeNull();
      expect(await (obj as unknown as { text: () => Promise<string> }).text()).toBe(validBody);
    } else {
      // If valid lost (409), oversized must have been file_too_large and no object should be oversized, but valid's retry would succeed
      // For now, ensure at least oversized is file_too_large and object is not oversized
      expect(oversizedError?.message).toBe("file_too_large");
      // Valid lost 409 means it can retry, but in this concurrent batch it lost; ensure object is not empty and not oversized
      expect(obj).not.toBeNull();
      // The object should not be oversized body
      expect(await (obj as unknown as { text: () => Promise<string> }).text()).not.toBe(oversizedBody);
    }
  });
});
