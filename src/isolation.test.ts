import { afterEach, describe, expect, it } from "vitest";
import { projectObjectKey } from "./files-api";
import type { DataPrincipal } from "./contracts";
import { addressedDatabases, createHarness, type Harness } from "./test-harness";

const principal = (projectId: string): DataPrincipal => ({
  keyId: `key-${projectId}`,
  projectId,
  databaseId: `database-${projectId}`,
  kind: "secret",
  scopes: ["project:admin"],
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
