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
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS mb_migration_imports (
        migration_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (migration_id, file_path)
      )`,
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (3, datetime('now'))",
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS mb_users (
        id TEXT PRIMARY KEY,
        email_normalized TEXT,
        phone_e164 TEXT,
        confirmed_at TEXT,
        required_action TEXT NOT NULL CHECK (required_action IN ('activation', 'none')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (email_normalized),
        UNIQUE (phone_e164),
        CHECK (email_normalized IS NOT NULL OR phone_e164 IS NOT NULL)
      )`,
      `CREATE TABLE IF NOT EXISTS mb_activation_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS mb_organization_memberships (
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
        status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS mb_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES mb_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        auth_version INTEGER NOT NULL CHECK (auth_version >= 1),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT,
        rotated_from_session_id TEXT REFERENCES mb_sessions(id) ON DELETE SET NULL,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS mb_auth_audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES mb_users(id) ON DELETE SET NULL,
        organization_id TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
        metadata TEXT,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS mb_memberships_user_status_idx ON mb_organization_memberships(user_id, status)",
      "CREATE INDEX IF NOT EXISTS mb_activation_user_active_idx ON mb_activation_tokens(user_id, used_at, revoked_at, expires_at)",
      "CREATE INDEX IF NOT EXISTS mb_sessions_user_active_idx ON mb_sessions(user_id, revoked_at, expires_at)",
      "CREATE INDEX IF NOT EXISTS mb_auth_audit_created_idx ON mb_auth_audit_events(created_at DESC)",
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (4, datetime('now'))",
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
