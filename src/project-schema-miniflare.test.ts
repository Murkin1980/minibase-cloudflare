import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { applyProjectSchema, inspectProjectSchema } from "./project-schema";
import type { MiniBaseEnv } from "./contracts";

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let controlDb: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let env: MiniBaseEnv;
const projectId = "proj-malformed-test";
const databaseId = "malformed-db";
const actorKeyId = "actor-1";

async function setupControlAndProject() {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { PROJECT_DB: databaseId, CONTROL_DB: "control-db" },
  });
  db = await mf.getD1Database("PROJECT_DB");
  controlDb = await mf.getD1Database("CONTROL_DB");
  await controlDb.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT, d1_database_id TEXT, data_schema_version INTEGER, status TEXT, updated_at TEXT)`);
  await controlDb.exec(`CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, project_id TEXT, action TEXT, created_at TEXT, actor_key_id TEXT, outcome TEXT, metadata TEXT, entity TEXT, entity_id TEXT, correlation_id TEXT)`);
  await controlDb.prepare(`INSERT INTO projects (id, slug, d1_database_id, data_schema_version, status, updated_at) VALUES (?, ?, ?, ?, 'active', ?)`).bind(projectId, "test", databaseId, 6, new Date().toISOString()).run();

  env = {
    CONTROL_DB: controlDb as unknown as MiniBaseEnv["CONTROL_DB"],
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_D1_API_TOKEN: "test-token",
  } as unknown as MiniBaseEnv;

  // Stub fetch for project D1 queries
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(`/d1/database/${databaseId}/query`)) return fetch(input as Request, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
    try {
      const result = await db.prepare(body.sql).bind(...(body.params ?? []) as never[]).all();
      return Response.json({ success: true, result: [result] });
    } catch (e) {
      const msg = (e as Error).message;
      return Response.json({ success: false, errors: [{ message: msg }] }, { status: 400 });
    }
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await mf?.dispose();
});

describe("project schema v7 authoritative publication — real SQLite", () => {
  beforeEach(async () => {
    await setupControlAndProject();
    // Apply up to v6
    const { projectSchemaMigrations } = await import("./project-schema");
    for (const mig of projectSchemaMigrations.filter((m) => m.version <= 6)) {
      for (const sql of mig.statements) await db.prepare(sql).run();
    }
    await db.prepare("INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (6, datetime('now'))").run();
  });

  it("malformed mb_artifacts causes apply failure, no version 7, no control update, retry after fix succeeds", async () => {
    // Create malformed mb_artifacts: missing UNIQUE on storage_key, missing NOT NULL on checksum
    await db.prepare(`DROP TABLE IF EXISTS mb_artifacts`).run();
    await db.prepare(`CREATE TABLE mb_artifacts (
      artifact_id TEXT PRIMARY KEY,
      storage_key TEXT,
      size INTEGER NOT NULL,
      content_type TEXT,
      etag TEXT NOT NULL,
      checksum_sha256 TEXT,
      uploaded_at TEXT,
      entity_type TEXT,
      entity_id TEXT,
      created_at TEXT NOT NULL
    )`).run();
    // Add the 4 ALTERs for mb_files partially? Let's add all 4 correctly so physical fails only due to artifact
    await db.prepare(`ALTER TABLE mb_files ADD COLUMN checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'))`).run();
    await db.prepare(`ALTER TABLE mb_files ADD COLUMN uploaded_at TEXT`).run();
    await db.prepare(`ALTER TABLE mb_files ADD COLUMN entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63 AND entity_type GLOB '[a-z]*' AND entity_type NOT GLOB '*[^a-z0-9_-]*' AND substr(entity_type,1,3) != 'mb_'))`).run();
    await db.prepare(`ALTER TABLE mb_files ADD COLUMN entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128 AND entity_id GLOB '[A-Za-z0-9]*' AND entity_id NOT GLOB '*[^A-Za-z0-9._:-]*'))`).run();

    await expect(applyProjectSchema(env, projectId, actorKeyId)).rejects.toThrow("inconsistent_schema_state");

    // Prove absence version 7
    const v7 = await db.prepare("SELECT version FROM mb_schema_versions WHERE version = 7").all();
    expect(v7.results).toHaveLength(0);
    // Prove absence control cache update
    const proj = await controlDb.prepare("SELECT data_schema_version FROM projects WHERE id = ?").bind(projectId).first<{ data_schema_version: number }>();
    expect(proj!.data_schema_version).toBe(6);
    // Next apply still pending (authoritative 6)
    const state = await inspectProjectSchema(env as MiniBaseEnv, databaseId);
    expect(state.authoritativeVersion).toBe(6);

    // Fix structure in new test setup: drop malformed and recreate correct
    await db.prepare(`DROP TABLE IF EXISTS mb_artifacts`).run();
    const v7mig = (await import("./project-schema")).projectSchemaMigrations.find((m) => m.version === 7)!;
    // Execute correct statements (excluding INSERT version)
    for (const sql of v7mig.statements.filter((s) => !s.includes("INSERT OR IGNORE INTO mb_schema_versions"))) {
      // Some ALTERs will now be duplicate column, but should be handled
      try { await db.prepare(sql).run(); } catch (e) {
        if (!(e as Error).message.includes("duplicate column name")) throw e;
      }
    }
    // Retry apply should now succeed (it will handle duplicate ALTERs and insert version 7)
    const result = await applyProjectSchema(env, projectId, actorKeyId);
    expect(result.version).toBe(7);
    expect(result.applied).toContain(7);
    const v7After = await db.prepare("SELECT version FROM mb_schema_versions WHERE version = 7").all();
    expect(v7After.results).toHaveLength(1);
    const projAfter = await controlDb.prepare("SELECT data_schema_version FROM projects WHERE id = ?").bind(projectId).first<{ data_schema_version: number }>();
    expect(projAfter!.data_schema_version).toBe(7);
  });

  it("partial migration after 1,2,3,4 ALTERs each fails physical and leaves version 7 absent, next apply pending and fix succeeds", async () => {
    const v7 = (await import("./project-schema")).projectSchemaMigrations.find((m) => m.version === 7)!;
    const alters = v7.statements.slice(0, 4);
    for (let n = 1; n <= 4; n++) {
      await mf.dispose();
      await setupControlAndProject();
      for (const mig of (await import("./project-schema")).projectSchemaMigrations.filter((m) => m.version <= 6)) {
        for (const sql of mig.statements) await db.prepare(sql).run();
      }
      await db.prepare("INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (6, datetime('now'))").run();
      for (let i = 0; i < n; i++) {
        await db.prepare(alters[i]).run();
      }
      // Do not apply full v7 yet — verify physical must fail, authoritative remains 6, no version 7
      const { verifyV7PhysicalStructure } = await import("./project-schema");
      const phys = await verifyV7PhysicalStructure(env, databaseId);
      expect(phys.ok).toBe(false);
      const state = await inspectProjectSchema(env, databaseId);
      expect(state.authoritativeVersion).toBe(6);
      const v7row = await db.prepare("SELECT version FROM mb_schema_versions WHERE version = 7").all();
      expect(v7row.results).toHaveLength(0);
      const proj = await controlDb.prepare("SELECT data_schema_version FROM projects WHERE id = ?").bind(projectId).first<{ data_schema_version: number }>();
      expect(proj!.data_schema_version).toBe(6);
      // Fix structure to full v7 correctly: execute remaining physical statements (via manual D1)
      for (const sql of v7.statements.filter((s) => !s.includes("INSERT OR IGNORE INTO mb_schema_versions"))) {
        try { await db.prepare(sql).run(); } catch (e) { if (!(e as Error).message.includes("duplicate column name")) throw e; }
      }
      const physAfterFix = await verifyV7PhysicalStructure(env, databaseId);
      expect(physAfterFix.ok).toBe(true);
      // Now apply should publish version 7 authoritative
      const result = await applyProjectSchema(env, projectId, actorKeyId);
      expect(result.version).toBe(7);
      const v7After = await db.prepare("SELECT version FROM mb_schema_versions WHERE version = 7").all();
      expect(v7After.results).toHaveLength(1);
      const projAfter = await controlDb.prepare("SELECT data_schema_version FROM projects WHERE id = ?").bind(projectId).first<{ data_schema_version: number }>();
      expect(projAfter!.data_schema_version).toBe(7);
      }
  }, 15000);
});
