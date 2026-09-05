import { describe, it, expect } from "vitest";
import { createHarness } from "./test-harness";

async function sha(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("artifact immutable concurrency — committed integration", () => {
  // mgmtAuth kept for reference but not used directly; harness uses managementKeys
  // Use real UUIDs for projectId so reconcile routes match if needed
  const projectA = { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", databaseId: "db-a", slug: "proj-a" };
  const projectB = { projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", databaseId: "db-b", slug: "proj-b" };

  it("concurrent same artifactId same bytes → exactly one 201, loser 409, winner bytes retained, no loser cleanup", async () => {
    const harness = createHarness({
      projects: [projectA, projectB],
      dataKeys: [
        { key: "mb_secret_aaaaaaaaaaaaaaaa", projectId: projectA.projectId, kind: "secret", scopes: ["project:admin"] },
        { key: "mb_secret_bbbbbbbbbbbbbbbb", projectId: projectB.projectId, kind: "secret", scopes: ["project:admin"] },
      ],
      managementKeys: [{ key: "mb_mgmt_test", scopes: ["projects:write"] }],
    });
    const body = "hello-artifact-same";
    const headers = (key: string) => ({
      authorization: `Bearer ${key}`,
      "content-length": String(new TextEncoder().encode(body).length),
      "content-type": "text/plain",
    });
    const [r1, r2] = await Promise.all([
      harness.request(`/v1/artifacts/originals/concurrent-same`, {
        method: "PUT",
        headers: headers("mb_secret_aaaaaaaaaaaaaaaa"),
        body,
      }),
      harness.request(`/v1/artifacts/originals/concurrent-same`, {
        method: "PUT",
        headers: headers("mb_secret_aaaaaaaaaaaaaaaa"),
        body,
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = r1.status === 201 ? r1 : r2;
    const winnerBody = await winner.json() as { artifactId: string; size: number; checksumSha256: string; etag: string };
    expect(winnerBody.artifactId).toBe("concurrent-same");
    expect(winnerBody.size).toBe(body.length);
    expect(winnerBody.checksumSha256).toBe(await sha(body));
    // Download returns winner bytes and headers
    const dl = await harness.request(`/v1/artifacts/originals/concurrent-same`, {
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa" },
    });
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(body);
    expect(dl.headers.get("x-minibase-sha256")).toBe(await sha(body));
    // R2 should have exactly one key, not deleted by loser
    expect(harness.r2Keys.filter((k) => k.includes("concurrent-same")).length).toBe(1);
    // Loser did not delete
    const winnerKey = `${projectA.projectId}/.mb_artifacts/originals/concurrent-same`;
    expect(harness.r2Keys).toContain(winnerKey);
    // D1 has winner
    const meta = harness.artifacts.get(projectA.databaseId)?.get("concurrent-same");
    expect(meta?.sha256).toBe(await sha(body));
    harness.dispose();
  });

  it("concurrent same artifactId diff bytes → exactly one 201, winner bytes not overwritten", async () => {
    const harness = createHarness({
      projects: [projectA],
      dataKeys: [{ key: "mb_secret_aaaaaaaaaaaaaaaa", projectId: projectA.projectId, kind: "secret", scopes: ["project:admin"] }],
      managementKeys: [{ key: "mb_mgmt_test", scopes: ["projects:write"] }],
    });
    const bodyA = "winner-payload-diff";
    const bodyB = "loser-payload-diff-xxxxx";
    const h = (key: string, body: string) => ({
      authorization: `Bearer ${key}`,
      "content-length": String(new TextEncoder().encode(body).length),
      "content-type": "text/plain",
    });
    const [r1, r2] = await Promise.all([
      harness.request(`/v1/artifacts/originals/concurrent-diff`, {
        method: "PUT",
        headers: h("mb_secret_aaaaaaaaaaaaaaaa", bodyA),
        body: bodyA,
      }),
      harness.request(`/v1/artifacts/originals/concurrent-diff`, {
        method: "PUT",
        headers: h("mb_secret_aaaaaaaaaaaaaaaa", bodyB),
        body: bodyB,
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winnerResp = r1.status === 201 ? r1 : r2;
    const winnerJson = await winnerResp.json() as { size: number; checksumSha256: string };
    void bodyA; void bodyB;
    // Download must equal winner's bytes
    const dl = await harness.request(`/v1/artifacts/originals/concurrent-diff`, {
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa" },
    });
    const dlText = await dl.text();
    expect(dl.status).toBe(200);
    expect([bodyA, bodyB]).toContain(dlText);
    expect(await sha(dlText)).toBe(winnerJson.checksumSha256);
    // R2 not overwritten by loser
    const key = `${projectA.projectId}/.mb_artifacts/originals/concurrent-diff`;
    expect(harness.r2Keys).toContain(key);
    harness.dispose();
  });

  it("D1 failure after R2 success leaves orphan, retry still 409 no overwrite, loser does not clean winner", async () => {
    const harness = createHarness({
      projects: [projectA],
      dataKeys: [{ key: "mb_secret_aaaaaaaaaaaaaaaa", projectId: projectA.projectId, kind: "secret", scopes: ["project:admin"] }],
      managementKeys: [{ key: "mb_mgmt_test", scopes: ["projects:write"] }],
      failArtifactInsertRequests: 1,
    });
    const body = "orphan-payload";
    const headers = {
      authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa",
      "content-length": String(body.length),
      "content-type": "text/plain",
    };
    const first = await harness.request(`/v1/artifacts/originals/orphan-art`, {
      method: "PUT",
      headers,
      body,
    });
    // First fails as D1 transport, but R2 orphan remains
    expect(first.status).toBe(502);
    const key = `${projectA.projectId}/.mb_artifacts/originals/orphan-art`;
    expect(harness.r2Keys).toContain(key);
    // Retry with same id must be 409 (R2 conditional prevents overwrite) even though D1 never succeeded
    const retry = await harness.request(`/v1/artifacts/originals/orphan-art`, {
      method: "PUT",
      headers,
      body: "different-payload-should-not-win",
    });
    expect(retry.status).toBe(409);
    // Winner is still the orphan's bytes, not the retry's
    const dl = await harness.request(`/v1/artifacts/originals/orphan-art`, {
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa" },
    });
    // No D1 row, so download should be 404 (artifact_not_found) because D1 missing, even though R2 orphan exists
    expect(dl.status).toBe(404);
    // But R2 still has orphan, and retry did not delete it
    expect(harness.r2Keys).toContain(key);
    harness.dispose();
  });

  it("cross-project same artifactId isolated", async () => {
    const harness = createHarness({
      projects: [projectA, projectB],
      dataKeys: [
        { key: "mb_secret_aaaaaaaaaaaaaaaa", projectId: projectA.projectId, kind: "secret", scopes: ["project:admin"] },
        { key: "mb_secret_bbbbbbbbbbbbbbbb", projectId: projectB.projectId, kind: "secret", scopes: ["project:admin"] },
      ],
      managementKeys: [{ key: "mb_mgmt_test", scopes: ["projects:write"] }],
    });
    const bodyA = "project-a-artifact";
    const bodyB = "project-b-artifact";
    const putA = await harness.request(`/v1/artifacts/originals/shared-id`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa",
        "content-length": String(bodyA.length),
        "content-type": "text/plain",
      },
      body: bodyA,
    });
    expect(putA.status).toBe(201);
    const putB = await harness.request(`/v1/artifacts/originals/shared-id`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_bbbbbbbbbbbbbbbb",
        "content-length": String(bodyB.length),
        "content-type": "text/plain",
      },
      body: bodyB,
    });
    expect(putB.status).toBe(201);
    // Each project sees its own bytes
    const dlA = await harness.request(`/v1/artifacts/originals/shared-id`, {
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa" },
    });
    const dlB = await harness.request(`/v1/artifacts/originals/shared-id`, {
      headers: { authorization: "Bearer mb_secret_bbbbbbbbbbbbbbbb" },
    });
    expect(await dlA.text()).toBe(bodyA);
    expect(await dlB.text()).toBe(bodyB);
    // R2 keys are distinct prefixes
    expect(harness.r2Keys).toContain(`${projectA.projectId}/.mb_artifacts/originals/shared-id`);
    expect(harness.r2Keys).toContain(`${projectB.projectId}/.mb_artifacts/originals/shared-id`);
    harness.dispose();
  });

  it("legacy PUT/DELETE /v1/files does not affect artifact namespace and vice versa", async () => {
    const harness = createHarness({
      projects: [projectA],
      dataKeys: [{ key: "mb_secret_aaaaaaaaaaaaaaaa", projectId: projectA.projectId, kind: "secret", scopes: ["project:admin"] }],
      managementKeys: [{ key: "mb_mgmt_test", scopes: ["projects:write"] }],
    });
    // Put an artifact
    const artBody = "artifact-data";
    const artPut = await harness.request(`/v1/artifacts/originals/iso-art`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa",
        "content-length": String(artBody.length),
        "content-type": "text/plain",
      },
      body: artBody,
    });
    expect(artPut.status).toBe(201);
    // Put a file with a similar name but not in artifact prefix
    const fileBody = "file-data";
    const filePut = await harness.request(`/v1/files/regular.txt`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa",
        "content-length": String(fileBody.length),
        "content-type": "text/plain",
      },
      body: fileBody,
    });
    expect(filePut.status).toBe(201);
    // Delete the file should not delete artifact
    const del = await harness.request(`/v1/files/regular.txt`, {
      method: "DELETE",
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa" },
    });
    expect(del.status).toBe(204);
    const dlArt = await harness.request(`/v1/artifacts/originals/iso-art`, {
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa" },
    });
    expect(dlArt.status).toBe(200);
    expect(await dlArt.text()).toBe(artBody);
    // Attempt to write via /v1/files with internal prefix must be 400
    const bad = await harness.request(`/v1/files/.mb_artifacts/originals/evil`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa",
        "content-length": "3",
        "content-type": "text/plain",
      },
      body: "bad",
    });
    expect(bad.status).toBe(400);
    harness.dispose();
  });

  it("publishable key can read artifact but not write", async () => {
    const harness = createHarness({
      projects: [projectA],
      dataKeys: [
        { key: "mb_secret_aaaaaaaaaaaaaaaa", projectId: projectA.projectId, kind: "secret", scopes: ["project:admin"] },
        { key: "mb_publishable_cccccccccccccccc", projectId: projectA.projectId, kind: "publishable", scopes: ["files:read"] },
      ],
      managementKeys: [{ key: "mb_mgmt_test", scopes: ["projects:write"] }],
    });
    const body = "secret-artifact";
    const put = await harness.request(`/v1/artifacts/originals/pub-test`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa",
        "content-length": String(body.length),
        "content-type": "text/plain",
      },
      body,
    });
    expect(put.status).toBe(201);
    const pubRead = await harness.request(`/v1/artifacts/originals/pub-test`, {
      headers: { authorization: "Bearer mb_publishable_cccccccccccccccc" },
    });
    expect(pubRead.status).toBe(200);
    const pubWrite = await harness.request(`/v1/artifacts/originals/pub-test-2`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_publishable_cccccccccccccccc",
        "content-length": "3",
        "content-type": "text/plain",
      },
      body: "bad",
    });
    expect(pubWrite.status).toBe(401);
    harness.dispose();
  });

  it("artifact download sets x-minibase-sha256 and verifies via createHash", async () => {
    const harness = createHarness({
      projects: [projectA],
      dataKeys: [{ key: "mb_secret_aaaaaaaaaaaaaaaa", projectId: projectA.projectId, kind: "secret", scopes: ["project:admin"] }],
      managementKeys: [{ key: "mb_mgmt_test", scopes: ["projects:write"] }],
    });
    const body = "verify-sha-body";
    await harness.request(`/v1/artifacts/originals/sha-test`, {
      method: "PUT",
      headers: {
        authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa",
        "content-length": String(body.length),
        "content-type": "text/plain",
      },
      body,
    });
    const dl = await harness.request(`/v1/artifacts/originals/sha-test`, {
      headers: { authorization: "Bearer mb_secret_aaaaaaaaaaaaaaaa" },
    });
    expect(dl.status).toBe(200);
    const headerSha = dl.headers.get("x-minibase-sha256");
    expect(headerSha).toBe(await sha(body));
    const downloaded = await dl.arrayBuffer();
    const computed = [...new Uint8Array(await crypto.subtle.digest("SHA-256", downloaded))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(computed).toBe(headerSha);
    harness.dispose();
  });
});
