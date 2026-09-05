import { afterEach, describe, expect, it } from "vitest";
import { projectObjectKey } from "./files-api";
import type { DataPrincipal } from "./contracts";
import { addressedDatabases, createHarness, type Harness, type HarnessProject } from "./test-harness";
import { DEFAULT_LIMITS } from "./limits";

const principal = (projectId: string): DataPrincipal => ({
  keyId: `key-${projectId}`,
  projectId,
  databaseId: `database-${projectId}`,
  kind: "secret",
  scopes: ["project:admin"],
  // CP-03: no stored quota, so the project is served at the deployment ceilings.
  limits: DEFAULT_LIMITS,
});

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
});

describe("project isolation", () => {
  it("binds every R2 object key to the authenticated project prefix", () => {
    expect(projectObjectKey(principal("project-a"), "docs/a.txt")).toBe("project-a/docs/a.txt");
    expect(projectObjectKey(principal("project-b"), "docs/a.txt")).toBe("project-b/docs/a.txt");
  });

  it("cannot escape the prefix by naming another project in the path", () => {
    // A caller that tries to address project B through the path still lands
    // inside its own prefix, so the attempt becomes a harmless nested key.
    expect(projectObjectKey(principal("project-a"), "project-b/secret.txt"))
      .toBe("project-a/project-b/secret.txt");
  });

  it("routes a project's credential only to that project's database", async () => {
    harness = createHarness({
      projects: [
        { projectId: "project-a", databaseId: "database-a", slug: "alpha" },
        { projectId: "project-b", databaseId: "database-b", slug: "beta" },
      ],
      dataKeys: [
        { key: "mb_publishable_aaaaaaaaaaaa", projectId: "project-a", kind: "publishable", scopes: ["data:read"] },
        { key: "mb_publishable_bbbbbbbbbbbb", projectId: "project-b", kind: "publishable", scopes: ["data:read"] },
      ],
    });

    const alpha = await harness.request("/v1/data/lessons", {
      headers: { authorization: "Bearer mb_publishable_aaaaaaaaaaaa" },
    });
    expect(alpha.status).toBe(200);
    expect(addressedDatabases(harness)).toEqual(["database-a"]);

    const beta = await harness.request("/v1/data/lessons", {
      headers: { authorization: "Bearer mb_publishable_bbbbbbbbbbbb" },
    });
    expect(beta.status).toBe(200);
    expect(addressedDatabases(harness)).toEqual(["database-a", "database-b"]);
  });

  it("never lets one project read or write another project's records", async () => {
    harness = createHarness({
      projects: [
        { projectId: "project-a", databaseId: "database-a", slug: "alpha" },
        { projectId: "project-b", databaseId: "database-b", slug: "beta" },
      ],
      dataKeys: [
        { key: "mb_secret_aaaaaaaaaaaaaa", projectId: "project-a", kind: "secret", scopes: ["project:admin"] },
        { key: "mb_secret_bbbbbbbbbbbbbb", projectId: "project-b", kind: "secret", scopes: ["project:admin"] },
      ],
    });
    const headerA = { authorization: "Bearer mb_secret_aaaaaaaaaaaaaa", "content-type": "application/json" };
    const headerB = { authorization: "Bearer mb_secret_bbbbbbbbbbbbbb", "content-type": "application/json" };

    await harness.request("/v1/data/orders/order-1", {
      method: "PUT", headers: headerA, body: JSON.stringify({ owner: "alpha" }),
    });

    // B cannot see A's record through the same collection and ID.
    const crossRead = await harness.request("/v1/data/orders/order-1", { headers: headerB });
    expect(crossRead.status).toBe(404);
    await expect(crossRead.json()).resolves.toEqual({ error: { code: "record_not_found" } });

    // B cannot delete A's record: the delete lands in B's own database.
    const crossDelete = await harness.request("/v1/data/orders/order-1", {
      method: "DELETE", headers: headerB,
    });
    expect(crossDelete.status).toBe(204);
    const stillThere = await harness.request("/v1/data/orders/order-1", { headers: headerA });
    expect(stillThere.status).toBe(200);
    expect(addressedDatabases(harness)).toEqual(["database-a", "database-b"]);
  });

  it("never lets one project address another project's objects", async () => {
    harness = createHarness({
      projects: [
        { projectId: "project-a", databaseId: "database-a", slug: "alpha" },
        { projectId: "project-b", databaseId: "database-b", slug: "beta" },
      ],
      dataKeys: [
        { key: "mb_secret_aaaaaaaaaaaaaa", projectId: "project-a", kind: "secret", scopes: ["project:admin"] },
        { key: "mb_secret_bbbbbbbbbbbbbb", projectId: "project-b", kind: "secret", scopes: ["project:admin"] },
      ],
    });
    const headerA = {
      authorization: "Bearer mb_secret_aaaaaaaaaaaaaa",
      "content-type": "text/plain", "content-length": "3",
    };
    await harness.request("/v1/files/notes/a.txt", { method: "PUT", headers: headerA, body: "abc" });
    expect(harness.r2Keys).toEqual(["project-a/notes/a.txt"]);

    const crossDownload = await harness.request("/v1/files/notes/a.txt", {
      headers: { authorization: "Bearer mb_secret_bbbbbbbbbbbbbb" },
    });
    expect(crossDownload.status).toBe(404);
    // Even a deliberate cross-tenant path stays inside the caller's prefix.
    const attempted = await harness.request("/v1/files/project-a/notes/a.txt", {
      headers: { authorization: "Bearer mb_secret_bbbbbbbbbbbbbb" },
    });
    expect(attempted.status).toBe(404);
    expect(harness.r2Keys.every((key) => key.startsWith("project-a/") || key.startsWith("project-b/")))
      .toBe(true);
  });

  it("rejects a data request from an origin outside the project allowlist", async () => {
    harness = createHarness({
      projects: [
        { projectId: "project-a", databaseId: "database-a", slug: "alpha", origins: ["https://alpha.test"] },
      ],
      dataKeys: [
        { key: "mb_publishable_aaaaaaaaaaaa", projectId: "project-a", kind: "publishable", scopes: ["data:read"] },
      ],
    });
    const allowed = await harness.request("/v1/data/lessons", {
      headers: { authorization: "Bearer mb_publishable_aaaaaaaaaaaa", origin: "https://alpha.test" },
    });
    expect(allowed.status).toBe(200);

    const denied = await harness.request("/v1/data/lessons", {
      headers: { authorization: "Bearer mb_publishable_aaaaaaaaaaaa", origin: "https://beta.test" },
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: { code: "origin_not_allowed" } });
  });

  it("refuses to serve a suspended project's data", async () => {
    harness = createHarness({
      projects: [
        { projectId: "project-a", databaseId: "database-a", slug: "alpha", status: "suspended" },
      ],
      dataKeys: [
        { key: "mb_publishable_aaaaaaaaaaaa", projectId: "project-a", kind: "publishable", scopes: ["data:read"] },
      ],
    });
    const response = await harness.request("/v1/data/lessons", {
      headers: { authorization: "Bearer mb_publishable_aaaaaaaaaaaa" },
    });
    expect(response.status).toBe(401);
    expect(addressedDatabases(harness)).toEqual([]);
  });
});

/**
 * CP-03: isolation must fail closed.
 *
 * `project_id` becomes the R2 key prefix and `d1_database_id` becomes a segment
 * of the Cloudflare REST path. Neither is a bound parameter, so neither may be
 * interpolation-shaped. Both come from the control plane, never from a request —
 * which is exactly why a corrupted control row is the remaining way to break the
 * boundary, and why it is refused here rather than repaired.
 */
describe("CP-03 fail-closed project context", () => {
  const secret = { authorization: "Bearer mb_secret_aaaaaaaaaaaaaa", "content-type": "application/json" };

  const malformedDatabaseIds = [
    "",
    "../other-account",
    "db/../../admin",
    "database-a?sql=SELECT",
    "database-a#fragment",
    "database a",
    "database%2Fa",
    "..",
  ];

  it("refuses a project whose database identity could redirect the REST path", async () => {
    for (const databaseId of malformedDatabaseIds) {
      harness?.dispose();
      harness = createHarness({
        projects: [{ projectId: "project-a", databaseId, slug: "alpha" }],
        dataKeys: [{
          key: "mb_secret_aaaaaaaaaaaaaa", projectId: "project-a", kind: "secret",
          scopes: ["project:admin"],
        }],
      });
      const response = await harness.request("/v1/data/orders", { headers: secret });
      expect(response.status, `databaseId=${JSON.stringify(databaseId)}`).toBe(401);
      // Not one outbound D1 REST call was made for the malformed identity.
      expect(harness.d1Calls, `databaseId=${JSON.stringify(databaseId)}`).toEqual([]);
    }
  });

  it("refuses a project id that could escape the R2 prefix", async () => {
    for (const projectId of ["../project-b", "project-a/../../other", "project a", "project-a?x=1", ".."]) {
      harness?.dispose();
      harness = createHarness({
        projects: [{ projectId, databaseId: "database-a", slug: "alpha" }],
        dataKeys: [{
          key: "mb_secret_aaaaaaaaaaaaaa", projectId, kind: "secret", scopes: ["project:admin"],
        }],
      });
      const response = await harness.request("/v1/files/notes/a.txt", {
        method: "PUT",
        headers: { ...secret, "content-type": "text/plain", "content-length": "3" },
        body: "abc",
      });
      expect(response.status, `projectId=${JSON.stringify(projectId)}`).toBe(401);
      // No object was addressed at all, so nothing landed outside the prefix.
      expect(harness.r2Keys, `projectId=${JSON.stringify(projectId)}`).toEqual([]);
    }
  });

  it("accepts the identities MiniBase actually issues", async () => {
    // The guard must not reject a real deployment: canonical UUIDs from
    // crypto.randomUUID() and from Cloudflare's D1 API are safe identities.
    harness = createHarness({
      projects: [{
        projectId: "58e27c56-0374-4a3f-84c5-90dca9bfcb3e",
        databaseId: "22250945-ad19-44e4-a18f-9012983bd5f6",
        slug: "alpha",
      }],
      dataKeys: [{
        key: "mb_secret_aaaaaaaaaaaaaa", projectId: "58e27c56-0374-4a3f-84c5-90dca9bfcb3e",
        kind: "secret", scopes: ["project:admin"],
      }],
    });
    const response = await harness.request("/v1/data/orders", { headers: secret });
    expect(response.status).toBe(200);
    expect(addressedDatabases(harness)).toEqual(["22250945-ad19-44e4-a18f-9012983bd5f6"]);
  });

  it("leaks nothing about whether a project exists", async () => {
    // Three different server-side states must be indistinguishable to the caller:
    // an unknown credential, a suspended project, and a corrupted control row.
    const observed: Array<{ status: number; body: unknown }> = [];
    const cases = [
      { label: "unknown credential", project: null as null | { status?: string; databaseId?: string } },
      { label: "suspended project", project: { status: "suspended" } },
      { label: "no database", project: { databaseId: "" } },
      { label: "malformed database", project: { databaseId: "../elsewhere" } },
    ];
    for (const testCase of cases) {
      harness?.dispose();
      harness = createHarness({
        projects: testCase.project === null
          ? []
          : [{
            projectId: "project-a",
            databaseId: testCase.project.databaseId ?? "database-a",
            slug: "alpha",
            ...(testCase.project.status ? { status: testCase.project.status } : {}),
          }],
        dataKeys: testCase.project === null ? [] : [{
          key: "mb_secret_aaaaaaaaaaaaaa", projectId: "project-a", kind: "secret",
          scopes: ["project:admin"],
        }],
      });
      const response = await harness.request("/v1/data/orders", { headers: secret });
      observed.push({ status: response.status, body: await response.json() });
      expect(harness.d1Calls, testCase.label).toEqual([]);
    }
    // Every caller sees the same 401 and the same envelope, so a probe cannot
    // enumerate which projects exist, are suspended, or are misconfigured.
    for (const entry of observed) {
      expect(entry.status).toBe(401);
      expect(entry.body).toEqual({ error: { code: "unauthorized" } });
    }
  });

  it("keeps the distinguishing detail in the audit log, not in the response", async () => {
    // Operators can still tell the cases apart; callers cannot.
    harness = createHarness({
      projects: [{ projectId: "project-a", databaseId: "../elsewhere", slug: "alpha" }],
      dataKeys: [{
        key: "mb_secret_aaaaaaaaaaaaaa", projectId: "project-a", kind: "secret",
        scopes: ["project:admin"],
      }],
    });
    await harness.request("/v1/data/orders", { headers: secret });
    const metadata = JSON.parse(String(harness.audit.at(-1)?.values[6])) as Record<string, string>;
    expect(metadata.reason).toBe("project_unavailable");
    expect(metadata.requiredScope).toBe("data:read");
    expect(JSON.stringify(metadata)).not.toContain("mb_secret_");
  });
});

/**
 * CP-03: a ceiling is per project. One tenant's quota, and one tenant's
 * exhausted rate bucket, must not be visible to any other tenant.
 */
describe("CP-03 per-project quotas and buckets", () => {
  const twoProjects = (quotasA: HarnessProject["quotas"] | undefined, options = {}) => createHarness({
    projects: [
      { projectId: "project-a", databaseId: "database-a", slug: "alpha", ...(quotasA ? { quotas: quotasA } : {}) },
      { projectId: "project-b", databaseId: "database-b", slug: "beta" },
    ],
    dataKeys: [
      { key: "mb_publishable_aaaaaaaaaaaa", projectId: "project-a", kind: "publishable", scopes: ["data:read"] },
      { key: "mb_publishable_bbbbbbbbbbbb", projectId: "project-b", kind: "publishable", scopes: ["data:read"] },
      { key: "mb_secret_aaaaaaaaaaaaaa", projectId: "project-a", kind: "secret", scopes: ["project:admin"] },
      { key: "mb_secret_bbbbbbbbbbbbbb", projectId: "project-b", kind: "secret", scopes: ["project:admin"] },
    ],
    ...options,
  });

  const readA = { authorization: "Bearer mb_publishable_aaaaaaaaaaaa" };
  const readB = { authorization: "Bearer mb_publishable_bbbbbbbbbbbb" };

  it("caps one project's page size while another keeps the deployment ceiling", async () => {
    harness = twoProjects({ maxPageSize: 10 });
    expect((await harness.request("/v1/data/lessons?limit=25", { headers: readA })).status).toBe(400);
    expect((await harness.request("/v1/data/lessons?limit=25", { headers: readB })).status).toBe(200);
    expect((await harness.request("/v1/data/lessons?limit=10", { headers: readA })).status).toBe(200);
  });

  it("caps one project's JSON body while another keeps the deployment ceiling", async () => {
    harness = twoProjects({ maxJsonBytes: 64 });
    const body = JSON.stringify({ value: "x".repeat(200) });
    const denied = await harness.request("/v1/data/orders/o1", {
      method: "PUT",
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaa", "content-type": "application/json" },
      body,
    });
    expect(denied.status).toBe(413);
    await expect(denied.json()).resolves.toEqual({ error: { code: "request_body_too_large" } });
    const allowed = await harness.request("/v1/data/orders/o1", {
      method: "PUT",
      headers: { authorization: "Bearer mb_secret_bbbbbbbbbbbbbb", "content-type": "application/json" },
      body,
    });
    expect(allowed.status).toBe(200);
    // The rejected write reached neither database.
    expect(addressedDatabases(harness)).toEqual(["database-b"]);
  });

  it("caps one project's upload size while another keeps the deployment ceiling", async () => {
    harness = twoProjects({ maxFileBytes: 8 });
    const upload = (key: string, size: number) => harness!.request("/v1/files/a.bin", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${key}`, "content-type": "application/octet-stream",
        "content-length": String(size),
      },
      body: "x".repeat(size),
    });
    expect((await upload("mb_secret_aaaaaaaaaaaaaa", 16)).status).toBe(413);
    expect((await upload("mb_secret_bbbbbbbbbbbbbb", 16)).status).toBe(201);
    expect((await upload("mb_secret_aaaaaaaaaaaaaa", 4)).status).toBe(201);
    // Only keys inside each project's own prefix were addressed.
    expect(harness.r2Keys).toEqual(["project-b/a.bin", "project-a/a.bin"]);
  });

  it("clamps a stored quota that exceeds the deployment ceiling", async () => {
    // A quota can only tighten. Even a row edited directly in the control D1 to a
    // value above the deployment ceiling is served at the deployment ceiling.
    harness = twoProjects({ maxPageSize: 90 }, { limits: { MB_MAX_PAGE_SIZE: "20" } });
    expect((await harness.request("/v1/data/lessons?limit=90", { headers: readA })).status).toBe(400);
    expect((await harness.request("/v1/data/lessons?limit=20", { headers: readA })).status).toBe(200);
    expect((await harness.request("/v1/data/lessons?limit=21", { headers: readB })).status).toBe(400);
  });

  it("denies an exhausted project before it spends more control-plane capacity", async () => {
    harness = createHarness({
      projects: [
        { projectId: "project-a", databaseId: "database-a", slug: "alpha", origins: ["https://alpha.test"] },
        { projectId: "project-b", databaseId: "database-b", slug: "beta", origins: ["https://beta.test"] },
      ],
      dataKeys: [
        { key: "mb_publishable_aaaaaaaaaaaa", projectId: "project-a", kind: "publishable", scopes: ["data:read"] },
        { key: "mb_publishable_bbbbbbbbbbbb", projectId: "project-b", kind: "publishable", scopes: ["data:read"] },
      ],
      rateLimitDeniedProjects: ["project-a"],
    });
    const denied = await harness.request("/v1/data/lessons", {
      headers: { ...readA, origin: "https://alpha.test" },
    });
    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toEqual({ error: { code: "rate_limited" } });
    const allowed = await harness.request("/v1/data/lessons", {
      headers: { ...readB, origin: "https://beta.test" },
    });
    expect(allowed.status).toBe(200);
    // The project bucket is consulted before the origin lookup, which is itself a
    // control-D1 read: only the served project paid for one.
    expect(harness.controlSql.filter((sql) => sql.includes("FROM project_origins"))).toHaveLength(1);
    expect(addressedDatabases(harness)).toEqual(["database-b"]);
  });

  it("gives each project a separate bucket per route class", async () => {
    harness = twoProjects(undefined, { perRouteRateLimiters: true });
    await harness.request("/v1/data/lessons", { headers: readA });
    await harness.request("/v1/data/lessons", { headers: readB });
    // A secret key, because the publishable keys above are data-read only.
    await harness.request("/v1/files", { headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaa" } });
    const projectKeys = harness.rateLimitCalls
      .filter((call) => call.key.includes(":project:"))
      .map((call) => `${call.binding} ${call.key}`);
    expect(projectKeys).toEqual([
      "RATE_LIMITER_DATA data:project:project-a",
      "RATE_LIMITER_DATA data:project:project-b",
      "RATE_LIMITER_FILES files:project:project-a",
    ]);
  });

  it("keeps cross-project record isolation under per-route rate periods", async () => {
    // Re-runs the CP-01 isolation proof with the CP-03 limiter shape, so the two
    // cannot drift apart.
    harness = twoProjects(undefined, { perRouteRateLimiters: true });
    const writeA = { authorization: "Bearer mb_secret_aaaaaaaaaaaaaa", "content-type": "application/json" };
    const readBsecret = { authorization: "Bearer mb_secret_bbbbbbbbbbbbbb" };
    await harness.request("/v1/data/orders/order-1", {
      method: "PUT", headers: writeA, body: JSON.stringify({ owner: "alpha" }),
    });
    const crossRead = await harness.request("/v1/data/orders/order-1", { headers: readBsecret });
    expect(crossRead.status).toBe(404);
    await expect(crossRead.json()).resolves.toEqual({ error: { code: "record_not_found" } });
    expect(addressedDatabases(harness)).toEqual(["database-a", "database-b"]);
  });

  it("refuses to serve a data request when limiting is required and unbound", async () => {
    harness = twoProjects(undefined, { omitRateLimiters: true, rateLimiterRequired: true });
    const response = await harness.request("/v1/data/lessons", { headers: readA });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: "rate_limiter_unavailable" } });
    expect(addressedDatabases(harness)).toEqual([]);
  });
});
