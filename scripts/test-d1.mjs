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

  async function applyMigration(migration) {
    const sql = await readFile(new URL(`../${migration}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  // 0001-0007 first, so the CP-03 checks below can exercise 0008 as a real
  // upgrade of a database that already holds tenant data.
  for (const migration of [
    "migrations/0001_control_plane.sql",
    "migrations/0002_management_keys.sql",
    "migrations/0003_provisioning_recovery.sql",
    "migrations/0004_data_keys.sql",
    "migrations/0005_project_origins.sql",
    "migrations/0006_project_schema_version.sql",
    "migrations/0007_audit_contract.sql",
  ]) {
    await applyMigration(migration);
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
  const auditColumns = await db.prepare("PRAGMA table_info(audit_events)").all();
  const auditColumnNames = new Set(auditColumns.results.map((column) => column.name));
  for (const expected of ["entity", "entity_id", "correlation_id"]) {
    assert.ok(auditColumnNames.has(expected), `missing audit_events.${expected}`);
  }

  const auditId = randomUUID();
  const correlationId = randomUUID();
  await db.prepare(
    `INSERT INTO audit_events
      (id, project_id, action, created_at, actor_key_id, outcome, metadata,
       entity, entity_id, correlation_id)
     VALUES (?, NULL, 'data.auth', ?, NULL, 'denied', ?, 'data_key', NULL, ?)`,
  ).bind(auditId, new Date().toISOString(), '{"reason":"unknown_key"}', correlationId).run();
  const auditRow = await db.prepare(
    "SELECT action, outcome, entity, entity_id, correlation_id FROM audit_events WHERE id = ?",
  ).bind(auditId).first();
  assert.equal(auditRow.entity, "data_key");
  assert.equal(auditRow.entity_id, null);
  assert.equal(auditRow.correlation_id, correlationId);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE correlation_id = ?")
      .bind(correlationId).first("count"),
    1,
  );

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

  // --- CP-03: 0008 applied as an upgrade of a populated control database ---
  //
  // The guarantee that matters is that a control D1 holding live tenants loses
  // nothing when 0008 runs. So a pre-CP-03 project, its keys, origins, schema
  // cache, and audit history are written first, then the migration is applied.
  const legacyProjectId = randomUUID();
  const legacyDatabaseId = randomUUID();
  const legacyKeyHash = "c".repeat(64);
  const legacyCreatedAt = "2026-08-25T00:00:00.000Z";
  await db.batch([
    db.prepare(
      `INSERT INTO projects
        (id, slug, name, status, d1_database_id, data_schema_version, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, 4, ?, ?)`,
    ).bind(legacyProjectId, "interactive-kp", "Interactive KP", legacyDatabaseId, legacyCreatedAt, legacyCreatedAt),
    db.prepare(
      `INSERT INTO api_keys
        (id, project_id, kind, key_hash, scopes, created_at, name, last_used_at)
       VALUES (?, ?, 'secret', ?, 'project:admin', ?, 'backend', ?)`,
    ).bind(randomUUID(), legacyProjectId, legacyKeyHash, legacyCreatedAt, legacyCreatedAt),
    db.prepare(
      "INSERT INTO project_origins (project_id, origin, created_at) VALUES (?, ?, ?)",
    ).bind(legacyProjectId, "https://kp.salamat-mebel.kz", legacyCreatedAt),
    db.prepare(
      `INSERT INTO audit_events
        (id, project_id, action, created_at, outcome, entity, entity_id, correlation_id)
       VALUES (?, ?, 'project.provisioned', ?, 'success', 'project', ?, ?)`,
    ).bind(randomUUID(), legacyProjectId, legacyCreatedAt, legacyProjectId, randomUUID()),
  ]);

  await applyMigration("migrations/0008_project_quotas.sql");

  // Nothing that existed before the migration changed.
  const preserved = await db.prepare(
    `SELECT slug, name, status, d1_database_id, data_schema_version, created_at, updated_at,
            quota_max_json_bytes, quota_max_file_bytes, quota_max_page_size, quota_max_bulk_records
       FROM projects WHERE id = ?`,
  ).bind(legacyProjectId).first();
  assert.equal(preserved.slug, "interactive-kp");
  assert.equal(preserved.name, "Interactive KP");
  assert.equal(preserved.status, "active");
  assert.equal(preserved.d1_database_id, legacyDatabaseId);
  assert.equal(preserved.data_schema_version, 4);
  assert.equal(preserved.created_at, legacyCreatedAt);
  assert.equal(preserved.updated_at, legacyCreatedAt);
  // A pre-CP-03 row reads NULL, which means "inherit the deployment ceiling".
  for (const column of [
    "quota_max_json_bytes", "quota_max_file_bytes", "quota_max_page_size", "quota_max_bulk_records",
  ]) {
    assert.equal(preserved[column], null, `${column} should be NULL on a migrated row`);
  }
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE key_hash = ?")
      .bind(legacyKeyHash).first("count"),
    1,
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM project_origins WHERE project_id = ?")
      .bind(legacyProjectId).first("count"),
    1,
  );
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE project_id = ?")
      .bind(legacyProjectId).first("count"),
    1,
  );

  // The CHECK constraints are the first fail-closed layer on a stored quota.
  for (const invalid of [0, -1]) {
    await assert.rejects(
      db.prepare("UPDATE projects SET quota_max_page_size = ? WHERE id = ?")
        .bind(invalid, legacyProjectId).run(),
      /CHECK constraint failed/,
      `quota_max_page_size = ${invalid} must be rejected`,
    );
  }
  await db.prepare("UPDATE projects SET quota_max_page_size = ? WHERE id = ?")
    .bind(25, legacyProjectId).run();
  assert.equal(
    await db.prepare("SELECT quota_max_page_size FROM projects WHERE id = ?")
      .bind(legacyProjectId).first("quota_max_page_size"),
    25,
  );
  // Clearing a quota returns it to NULL, so a project can always go back to
  // inheriting the deployment ceiling.
  await db.prepare("UPDATE projects SET quota_max_page_size = NULL WHERE id = ?")
    .bind(legacyProjectId).run();
  assert.equal(
    await db.prepare("SELECT quota_max_page_size FROM projects WHERE id = ?")
      .bind(legacyProjectId).first("quota_max_page_size"),
    null,
  );

  // The quota columns are readable through the exact join the data plane uses.
  const joined = await db.prepare(
    `SELECT k.id, p.d1_database_id, p.status,
            p.quota_max_json_bytes, p.quota_max_file_bytes,
            p.quota_max_page_size, p.quota_max_bulk_records
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
      WHERE k.key_hash = ?`,
  ).bind(legacyKeyHash).first();
  assert.equal(joined.d1_database_id, legacyDatabaseId);
  assert.equal(joined.quota_max_page_size, null);

  console.log("D1 integration checks passed");
} finally {
  await mf.dispose();
}
