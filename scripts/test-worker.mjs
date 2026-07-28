import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const mf = new Miniflare({
  modules: true,
  scriptPath: fileURLToPath(new URL("../work/worker-bundle/index.js", import.meta.url)),
  compatibilityDate: "2026-07-28",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { CONTROL_DB: randomUUID() },
  r2Buckets: { FILES: "minibase-test-files" },
  bindings: {
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_D1_API_TOKEN: "test-token-never-returned",
  },
  cf: false,
});

try {
  const db = await mf.getD1Database("CONTROL_DB");
  const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const sql = await readFile(`${projectRoot}migrations/${migration}`, "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  const managementKey = "mb_management_worker-integration-owner";
  const managementHash = createHash("sha256").update(managementKey).digest("hex");
  const managementKeyId = randomUUID();
  const projectId = randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "INSERT INTO management_keys (id, name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(managementKeyId, "worker test owner", managementHash, "keys:write", now),
    db.prepare(
      `INSERT INTO projects
        (id, slug, name, status, d1_database_id, data_schema_version, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, 1, ?, ?)`,
    ).bind(projectId, "worker-test", "Worker Test", randomUUID(), now, now),
  ]);

  const health = await mf.dispatchFetch("https://minibase.test/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, "0.11.0");

  const unauthorized = await mf.dispatchFetch(`https://minibase.test/v1/projects/${projectId}/keys`);
  assert.equal(unauthorized.status, 401);

  const issued = await mf.dispatchFetch(`https://minibase.test/v1/projects/${projectId}/keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${managementKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "browser", kind: "publishable", scopes: ["data:read"] }),
  });
  assert.equal(issued.status, 201);
  const issuedBody = await issued.json();
  assert.match(issuedBody.key, /^mb_publishable_[a-f0-9]{64}$/);

  const listed = await mf.dispatchFetch(`https://minibase.test/v1/projects/${projectId}/keys`, {
    headers: { authorization: `Bearer ${managementKey}` },
  });
  assert.equal(listed.status, 200);
  const listedText = await listed.text();
  assert.equal(listedText.includes(issuedBody.key), false);
  assert.equal(listedText.includes("key_hash"), false);

  const deniedScope = await mf.dispatchFetch(`https://minibase.test/v1/projects/${projectId}/origins`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${managementKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ origins: ["https://app.test"] }),
  });
  assert.equal(deniedScope.status, 401);

  const preflight = await mf.dispatchFetch("https://minibase.test/v1/data/lessons", {
    method: "OPTIONS",
    headers: { origin: "https://app.test" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.test");

  console.log("Worker integration checks passed");
} finally {
  await mf.dispose();
}
