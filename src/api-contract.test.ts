import { afterEach, describe, expect, it, vi } from "vitest";
import { addressedDatabases, createHarness, type Harness } from "./test-harness";

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
  vi.useRealTimers();
});

function singleProject(overrides = {}) {
  return createHarness({
    projects: [{ projectId: "project-a", databaseId: "database-a", slug: "alpha" }],
    dataKeys: [
      {
        key: "mb_publishable_read", projectId: "project-a", kind: "publishable",
        // Mirrors initialPublishableKeyScopes: what a provisioned project gets.
        scopes: ["data:read", "files:read"],
      },
      { key: "mb_secret_write", projectId: "project-a", kind: "secret", scopes: ["project:admin"] },
    ],
    ...overrides,
  });
}

const read = { authorization: "Bearer mb_publishable_read" };
const write = { authorization: "Bearer mb_secret_write", "content-type": "application/json" };

interface ListBody {
  records: Array<{ id: string }>;
  nextAfter: string | null;
  hasMore: boolean;
}

describe("query API contract", () => {
  it("returns a large collection completely and in stable order", async () => {
    harness = singleProject();
    const store = new Map<string, { id: string; data: string; created_at: string; updated_at: string }>();
    // 250 records: not a multiple of the page size, so the final page is short.
    for (let index = 0; index < 250; index += 1) {
      const id = `rec-${String(index).padStart(4, "0")}`;
      store.set(id, { id, data: JSON.stringify({ index }), created_at: "2026-09-03", updated_at: "2026-09-03" });
    }
    harness.records.get("database-a")!.set("lessons", store);

    const seen: string[] = [];
    const flags: boolean[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const path = `/v1/data/lessons?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const response = await harness.request(path, { headers: read });
      expect(response.status).toBe(200);
      const body = await response.json() as ListBody;
      expect(body.records.length).toBeLessThanOrEqual(100);
      seen.push(...body.records.map((record) => record.id));
      flags.push(body.hasMore);
      if (!body.hasMore) break;
      after = body.nextAfter;
      expect(after).not.toBeNull();
    }

    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(seen).toEqual([...seen].sort());
    expect(flags).toEqual([true, true, false]);
  });

  it("reports hasMore false on a short final page while keeping nextAfter", async () => {
    harness = singleProject();
    for (const id of ["a", "b"]) {
      harness.records.get("database-a")!.set("lessons", new Map([
        ...(harness.records.get("database-a")!.get("lessons") ?? new Map()),
        [id, { id, data: "{}", created_at: "2026-09-03", updated_at: "2026-09-03" }],
      ]));
    }
    const body = await (await harness.request("/v1/data/lessons?limit=100", { headers: read }))
      .json() as ListBody;
    expect(body.records.map((record) => record.id)).toEqual(["a", "b"]);
    expect(body.hasMore).toBe(false);
    // Backward compatible: the cursor is still returned, so a consumer that only
    // reads `nextAfter` keeps working; it just no longer has to guess.
    expect(body.nextAfter).toBe("b");
  });

  it("returns an empty terminal page rather than a dangling cursor", async () => {
    harness = singleProject();
    const body = await (await harness.request("/v1/data/lessons", { headers: read })).json() as ListBody;
    expect(body).toEqual({ records: [], nextAfter: null, hasMore: false });
  });
});

describe("request limits", () => {
  it("rejects an out-of-range page size", async () => {
    harness = singleProject();
    for (const limit of ["0", "101", "1.5", "abc"]) {
      const response = await harness.request(`/v1/data/lessons?limit=${limit}`, { headers: read });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: { code: "invalid_limit" } });
    }
  });

  it("rejects an oversized JSON body", async () => {
    harness = singleProject();
    const response = await harness.request("/v1/data/lessons/x", {
      method: "PUT", headers: write, body: JSON.stringify({ value: "x".repeat(70 * 1024) }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "request_body_too_large" } });
    expect(addressedDatabases(harness)).toEqual([]);
  });

  it("applies configured overrides without changing defaults for other tenants", async () => {
    harness = singleProject({ limits: { MB_MAX_PAGE_SIZE: "20", MB_MAX_JSON_BYTES: "64" } });
    const tooBigPage = await harness.request("/v1/data/lessons?limit=50", { headers: read });
    expect(tooBigPage.status).toBe(400);
    const allowedPage = await harness.request("/v1/data/lessons?limit=20", { headers: read });
    expect(allowedPage.status).toBe(200);
    const tooBigBody = await harness.request("/v1/data/lessons/x", {
      method: "PUT", headers: write, body: JSON.stringify({ value: "x".repeat(200) }),
    });
    expect(tooBigBody.status).toBe(413);
  });

  it("rejects an oversized upload before reading the body", async () => {
    harness = singleProject();
    const response = await harness.request("/v1/files/a.bin", {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_write",
        "content-type": "application/octet-stream",
        "content-length": String(26 * 1024 * 1024),
      },
      body: "abc",
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: { code: "file_too_large" } });
    expect(harness.r2Keys).toEqual([]);
  });

  it("stores the measured upload size rather than the declared one", async () => {
    harness = singleProject();
    // Content-Length claims 3 but the body is 11 bytes: the stored size must be
    // what R2 actually received.
    const response = await harness.request("/v1/files/a.txt", {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_write",
        "content-type": "text/plain",
        "content-length": "3",
      },
      body: "hello world",
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { size: number; etag: string };
    expect(body.size).toBe(11);
    expect(harness.files.get("database-a")!.get("a.txt")!.size).toBe(11);
  });
});

describe("idempotency", () => {
  it("refuses provisioning without an Idempotency-Key", async () => {
    harness = createHarness({
      projects: [],
      managementKeys: [{ key: "mb_management_owner", scopes: ["projects:write"] }],
    });
    const response = await harness.request("/v1/projects", {
      method: "POST",
      headers: { authorization: "Bearer mb_management_owner", "content-type": "application/json" },
      body: JSON.stringify({ slug: "alpha-project", name: "Alpha Project" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_idempotency_key" } });
  });
});

describe("audit contract", () => {
  it("correlates a denial with the request ID the caller already received", async () => {
    harness = singleProject();
    const response = await harness.request("/v1/data/lessons", {
      headers: { authorization: "Bearer mb_publishable_unknown-key" },
    });
    expect(response.status).toBe(401);
    const requestId = response.headers.get("x-minibase-request-id");
    expect(requestId).toBeTruthy();

    expect(harness.audit).toHaveLength(1);
    const [, projectId, action, , actorKeyId, outcome, metadata, entity, entityId, correlationId] =
      harness.audit[0].values as unknown[];
    expect(action).toBe("data.auth");
    expect(outcome).toBe("denied");
    expect(entity).toBe("data_key");
    expect(actorKeyId).toBeNull();
    expect(entityId).toBeNull();
    expect(projectId).toBeNull();
    expect(correlationId).toBe(requestId);
    expect(String(metadata)).toContain("unknown_key");
    // The raw bearer token must never reach the audit log.
    expect(JSON.stringify(harness.audit[0].values)).not.toContain("mb_publishable_unknown-key");
  });

  it("exposes the audit fields through the management endpoint", async () => {
    harness = createHarness({
      projects: [],
      managementKeys: [{ key: "mb_management_auditor", scopes: ["audit:read"] }],
    });
    await harness.request("/v1/data/lessons", { headers: { authorization: "Bearer mb_publishable_x" } });
    const response = await harness.request("/v1/audit-events?limit=10", {
      headers: { authorization: "Bearer mb_management_auditor" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      events: Array<{ action: string; entity: string | null; correlationId: string | null }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ action: "data.auth", entity: "data_key" });
    expect(body.events[0].correlationId).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
  });
});

describe("control-plane cost per request", () => {
  const activityWrites = (target: Harness) =>
    target.controlSql.filter((sql) => sql.includes("UPDATE api_keys SET last_used_at")).length;

  it("writes key activity once per interval, not once per request", async () => {
    harness = singleProject();
    for (let index = 0; index < 10; index += 1) {
      const response = await harness.request("/v1/data/lessons?limit=10", { headers: read });
      expect(response.status).toBe(200);
    }
    // Ten data reads still reach the project database ten times...
    expect(harness.d1Calls).toHaveLength(10);
    // ...but cost the shared control D1 a single write row instead of ten.
    expect(activityWrites(harness)).toBe(1);
  });

  it("restores per-request activity recording when the interval is shortened", async () => {
    harness = singleProject({ limits: { MB_KEY_ACTIVITY_INTERVAL_MS: "1000" } });
    // A controlled clock: without it this assertion would depend on whether two
    // requests happened to land in the same millisecond.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    for (let index = 0; index < 3; index += 1) {
      const response = await harness.request("/v1/data/lessons?limit=10", { headers: read });
      expect(response.status).toBe(200);
      vi.advanceTimersByTime(1000);
    }
    expect(activityWrites(harness)).toBe(3);
  });

  it("costs one control write per denied authentication", async () => {
    harness = singleProject();
    for (let index = 0; index < 5; index += 1) {
      const response = await harness.request("/v1/data/lessons", {
        headers: { authorization: "Bearer mb_publishable_bad-key" },
      });
      expect(response.status).toBe(401);
    }
    expect(harness.audit).toHaveLength(5);
    expect(harness.d1Calls).toHaveLength(0);
  });
});

describe("existing consumer compatibility", () => {
  it("keeps the Records API response shape a superset of the previous one", async () => {
    harness = singleProject();
    const put = await harness.request("/v1/data/lessons/lesson-1", {
      method: "PUT", headers: write, body: JSON.stringify({ title: "Intro" }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as Record<string, unknown>;
    expect(putBody).toEqual(expect.objectContaining({
      id: "lesson-1", data: { title: "Intro" }, updatedAt: expect.any(String),
    }));

    const got = await harness.request("/v1/data/lessons/lesson-1", { headers: read });
    expect(got.status).toBe(200);
    const gotBody = await got.json() as Record<string, unknown>;
    expect(gotBody).toEqual(expect.objectContaining({
      id: "lesson-1", data: { title: "Intro" },
      createdAt: expect.any(String), updatedAt: expect.any(String),
    }));

    const listed = await harness.request("/v1/data/lessons?limit=25&after=lesson-0", { headers: read });
    const listBody = await listed.json() as Record<string, unknown>;
    expect(listBody).toEqual(expect.objectContaining({
      records: expect.any(Array), nextAfter: "lesson-1",
    }));

    const removed = await harness.request("/v1/data/lessons/lesson-1", {
      method: "DELETE", headers: write,
    });
    expect(removed.status).toBe(204);
    const after = await harness.request("/v1/data/lessons/lesson-1", { headers: read });
    expect(after.status).toBe(404);
  });

  it("keeps the Files API response shape a superset of the previous one", async () => {
    harness = singleProject();
    const uploaded = await harness.request("/v1/files/docs/a.txt", {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_write", "content-type": "text/plain", "content-length": "5",
      },
      body: "hello",
    });
    expect(uploaded.status).toBe(201);
    const uploadBody = await uploaded.json() as Record<string, unknown>;
    expect(uploadBody).toEqual(expect.objectContaining({
      path: "docs/a.txt", size: 5, contentType: "text/plain",
      etag: expect.any(String), updatedAt: expect.any(String),
    }));

    const listed = await harness.request("/v1/files?limit=50", { headers: read });
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { files: Array<Record<string, unknown>> };
    expect(listBody.files[0]).toEqual(expect.objectContaining({
      path: "docs/a.txt", size: 5, contentType: "text/plain",
      etag: expect.any(String), createdAt: expect.any(String), updatedAt: expect.any(String),
    }));

    const downloaded = await harness.request("/v1/files/docs/a.txt", { headers: read });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("text/plain");
    expect(downloaded.headers.get("content-length")).toBe("5");
    expect(await downloaded.text()).toBe("hello");

    const removed = await harness.request("/v1/files/docs/a.txt", {
      method: "DELETE", headers: write,
    });
    expect(removed.status).toBe(204);
    const missing = await harness.request("/v1/files/docs/a.txt", { headers: read });
    expect(missing.status).toBe(404);
  });

  it("keeps the unified error envelope and security headers", async () => {
    harness = singleProject();
    const response = await harness.request("/v1/data/lessons");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "unauthorized" } });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-minibase-request-id")).toBeTruthy();
  });

  it("rejects path traversal before touching storage", async () => {
    harness = singleProject();
    // Percent-encoded, so the traversal survives URL normalization and actually
    // reaches validateFilePath rather than being collapsed by the URL parser.
    for (const path of [
      "..%2Fetc%2Fpasswd", "a%2F..%2F..%2Fb", "..%2Fsecret", "a%2F%2Fb", "docs%2F",
    ]) {
      const response = await harness.request(`/v1/files/${path}`, {
        headers: { authorization: "Bearer mb_secret_write" },
      });
      expect([400, 404]).toContain(response.status);
    }
    expect(harness.r2Keys).toEqual([]);
  });
});
