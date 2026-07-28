import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } }",
  compatibilityDate: "2026-07-28",
  d1Databases: { CONTROL_DB: randomUUID() },
  cf: false,
});

try {
  const db = await mf.getD1Database("CONTROL_DB");
  for (const migration of [
    "migrations/0001_control_plane.sql",
    "migrations/0002_management_keys.sql",
    "migrations/0003_provisioning_recovery.sql",
    "migrations/0004_data_keys.sql",
    "migrations/0005_project_origins.sql",
    "migrations/0006_project_schema_version.sql",
  ]) {
    const sql = await readFile(new URL(`../${migration}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  const keyId = randomUUID();
  const keyHash = "a".repeat(64);
  await db.prepare(
    `INSERT INTO management_keys
      (id, name, key_hash, scopes, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(keyId, "integration key", keyHash, "projects:write", new Date().toISOString()).run();
  const key = await db.prepare(
    "SELECT key_hash, scopes, revoked_at FROM management_keys WHERE id = ?",
  ).bind(keyId).first();
  assert.equal(key.key_hash, keyHash);
  assert.equal(key.scopes, "projects:write");
  assert.equal(key.revoked_at, null);

  await db.prepare("UPDATE management_keys SET revoked_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), keyId).run();
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM management_keys WHERE id = ? AND revoked_at IS NULL")
      .bind(keyId).first("count"),
    0,
  );

  const jobColumns = await db.prepare("PRAGMA table_info(provisioning_jobs)").all();
  const columnNames = new Set(jobColumns.results.map((column) => column.name));
  for (const expected of ["request_hash", "d1_database_id", "rollback_status", "attempt_count"]) {
    assert.ok(columnNames.has(expected), `missing provisioning_jobs.${expected}`);
  }
  const keyColumns = await db.prepare("PRAGMA table_info(api_keys)").all();
  const keyColumnNames = new Set(keyColumns.results.map((column) => column.name));
  for (const expected of ["name", "last_used_at", "rotated_from_key_id"]) {
    assert.ok(keyColumnNames.has(expected), `missing api_keys.${expected}`);
  }
  const originTable = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_origins'",
  ).first();
  assert.equal(originTable.name, "project_origins");
  const projectColumns = await db.prepare("PRAGMA table_info(projects)").all();
  assert.ok(projectColumns.results.some((column) => column.name === "data_schema_version"));

  const atomicHash = "b".repeat(64);
  await assert.rejects(db.batch([
    db.prepare(
      "INSERT INTO management_keys (id, name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(randomUUID(), "atomic first", atomicHash, "keys:write", new Date().toISOString()),
    db.prepare(
      "INSERT INTO management_keys (id, name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(randomUUID(), "atomic duplicate", atomicHash, "keys:write", new Date().toISOString()),
  ]));
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM management_keys WHERE key_hash = ?")
      .bind(atomicHash).first("count"),
    0,
  );

  console.log("D1 integration checks passed");
} finally {
  await mf.dispose();
}
