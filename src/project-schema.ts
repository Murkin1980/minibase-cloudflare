import type { MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";

export interface ProjectSchemaMigration {
  version: number;
  statements: string[];
}

export const projectSchemaMigrations: ProjectSchemaMigration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE IF NOT EXISTS mb_schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      `CREATE TABLE IF NOT EXISTS mb_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      )`,
      "CREATE INDEX IF NOT EXISTS mb_records_collection_updated_idx ON mb_records(collection, updated_at DESC)",
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (1, datetime('now'))",
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS mb_files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        content_type TEXT,
        etag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS mb_files_updated_idx ON mb_files(updated_at DESC)",
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (2, datetime('now'))",
    ],
  },
];

export function pendingProjectSchemaVersions(currentVersion: number): ProjectSchemaMigration[] {
  if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("invalid_schema_version");
  return projectSchemaMigrations.filter((migration) => migration.version > currentVersion);
}

export async function applyProjectSchema(
  env: MiniBaseEnv,
  projectId: string,
  actorKeyId: string,
): Promise<{ previousVersion: number; version: number; applied: number[] }> {
  const project = await env.CONTROL_DB.prepare(
    "SELECT d1_database_id, data_schema_version FROM projects WHERE id = ? AND status = 'active'",
  ).bind(projectId).first<{ d1_database_id: string; data_schema_version: number }>();
  if (!project?.d1_database_id) throw new Error("project_not_found");
  const pending = pendingProjectSchemaVersions(project.data_schema_version);
  for (const migration of pending) {
    for (const sql of migration.statements) {
      await queryProjectD1(env, project.d1_database_id, sql, []);
    }
    await env.CONTROL_DB.prepare(
      "UPDATE projects SET data_schema_version = ?, updated_at = ? WHERE id = ? AND data_schema_version < ?",
    ).bind(migration.version, new Date().toISOString(), projectId, migration.version).run();
  }
  const version = pending.at(-1)?.version ?? project.data_schema_version;
  await env.CONTROL_DB.prepare(
    `INSERT INTO audit_events
      (id, project_id, action, created_at, actor_key_id, outcome, metadata)
     VALUES (?, ?, 'project.schema_applied', ?, ?, 'success', ?)`,
  ).bind(
    crypto.randomUUID(), projectId, new Date().toISOString(), actorKeyId,
    JSON.stringify({ previousVersion: project.data_schema_version, version }),
  ).run();
  return {
    previousVersion: project.data_schema_version,
    version,
    applied: pending.map((migration) => migration.version),
  };
}
