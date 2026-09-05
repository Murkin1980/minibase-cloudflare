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
  {
    /**
     * CP-04 query indexes.
     *
     * Index-only, by design: no `ALTER TABLE`, no generated column, no row
     * rewrite. `mb_records` already stores `created_at`, `updated_at`, and the
     * JSON document, so every supported CP-04 query is servable from an index
     * built over existing data. That keeps the upgrade of a populated project
     * database — including the live tenant — a pure metadata operation that
     * cannot lose or alter a record, and keeps the Worker from ever writing a
     * column an un-migrated tenant lacks.
     *
     * Each index ends in `id` because `id` is the tie-breaker every keyset
     * cursor uses; without it a page boundary inside a run of equal timestamps
     * could skip or repeat rows. The `schemaVersion` expression index uses the
     * same fixed JSON path the query builder emits, which is the only reason
     * SQLite can match it.
     */
    version: 5,
    statements: [
      "CREATE INDEX IF NOT EXISTS mb_records_collection_created_id_idx ON mb_records(collection, created_at, id)",
      "CREATE INDEX IF NOT EXISTS mb_records_collection_updated_id_idx ON mb_records(collection, updated_at, id)",
      `CREATE INDEX IF NOT EXISTS mb_records_collection_schema_version_id_idx
        ON mb_records(collection, json_extract(data, '$.schemaVersion'), id)`,
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (5, datetime('now'))",
    ],
  },
  {
    /**
     * CP-05 command marker and its one static multi-record-upsert trigger.
     *
     * A command arrives as one parameterized INSERT into `mb_commands`. Its
     * AFTER INSERT trigger expands only the already-validated canonical JSON
     * payload into `mb_records`, so SQLite commits the marker and every target
     * record together or rolls the whole statement back. The trigger has no
     * caller-selected SQL names, paths, or operations. Replays reach the
     * INSERT's conflict branch instead and never fire this trigger.
     */
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS mb_commands (
        command_id TEXT PRIMARY KEY CHECK (length(command_id) BETWEEN 1 AND 64),
        command_type TEXT NOT NULL CHECK (command_type = 'records:upsert-many'),
        idempotency_key_hash TEXT NOT NULL
          CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
        request_fingerprint TEXT NOT NULL
          CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
        normalized_payload TEXT NOT NULL
          CHECK (json_valid(normalized_payload))
          CHECK (COALESCE(json_type(normalized_payload, '$.operations') = 'array', 0))
          CHECK (COALESCE(json_array_length(normalized_payload, '$.operations'), 0) BETWEEN 1 AND 1000),
        response_json TEXT NOT NULL
          CHECK (json_valid(response_json))
          CHECK (COALESCE(json_type(response_json) = 'object', 0)),
        status TEXT NOT NULL CHECK (status = 'completed'),
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE (command_type, idempotency_key_hash)
      )`,
      `CREATE TRIGGER IF NOT EXISTS mb_commands_records_upsert_many_apply
        AFTER INSERT ON mb_commands
        WHEN NEW.command_type = 'records:upsert-many'
        BEGIN
          -- The table checks reject malformed JSON. Keep the trigger's static
          -- structural checks as a second boundary so a direct malformed marker
          -- cannot become a completed no-op command.
          SELECT CASE WHEN
            json_valid(NEW.normalized_payload) = 0
            OR COALESCE(json_type(NEW.normalized_payload, '$.operations') = 'array', 0) = 0
            OR COALESCE(json_array_length(NEW.normalized_payload, '$.operations'), 0) NOT BETWEEN 1 AND 1000
            OR EXISTS (
              SELECT 1 FROM json_each(NEW.normalized_payload) AS root_field
               WHERE root_field.key <> 'operations'
            )
          THEN RAISE(ABORT, 'invalid_command_payload') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1
              FROM json_each(NEW.normalized_payload, '$.operations') AS operation
             WHERE json_type(operation.value, '$.collection') IS NOT 'text'
                OR json_type(operation.value, '$.id') IS NOT 'text'
                OR json_type(operation.value, '$.data') IS NOT 'object'
                OR EXISTS (
                  SELECT 1 FROM json_each(operation.value) AS operation_field
                   WHERE operation_field.key NOT IN ('collection', 'id', 'data')
                )
                OR length(json_extract(operation.value, '$.collection')) NOT BETWEEN 2 AND 63
                OR json_extract(operation.value, '$.collection') NOT GLOB '[a-z]*'
                OR json_extract(operation.value, '$.collection') GLOB '*[^a-z0-9_-]*'
                OR substr(json_extract(operation.value, '$.collection'), 1, 3) = 'mb_'
                OR length(json_extract(operation.value, '$.id')) NOT BETWEEN 1 AND 128
                OR json_extract(operation.value, '$.id') NOT GLOB '[A-Za-z0-9]*'
                OR json_extract(operation.value, '$.id') GLOB '*[^A-Za-z0-9._:-]*'
          ) THEN RAISE(ABORT, 'invalid_command_payload') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1
              FROM json_each(NEW.normalized_payload, '$.operations') AS operation
             GROUP BY json_extract(operation.value, '$.collection'), json_extract(operation.value, '$.id')
            HAVING count(*) > 1
          ) THEN RAISE(ABORT, 'invalid_command_payload') END;
          INSERT INTO mb_records (collection, id, data, created_at, updated_at)
          SELECT json_extract(operation.value, '$.collection'),
                 json_extract(operation.value, '$.id'),
                 json_extract(operation.value, '$.data'),
                 NEW.created_at,
                 NEW.completed_at
            FROM json_each(NEW.normalized_payload, '$.operations') AS operation
           WHERE 1
          ON CONFLICT(collection, id) DO UPDATE SET
            data = excluded.data,
            updated_at = excluded.updated_at;
        END`,
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (6, datetime('now'))",
    ],
  },
];

export const latestKnownProjectSchemaVersion = projectSchemaMigrations.at(-1)?.version ?? 0;

export interface ProjectSchemaState {
  authoritativeVersion: number;
  appliedVersions: number[];
  hasVersionTable: boolean;
  issues: string[];
}

export interface ProjectSchemaVerification {
  projectId: string;
  status: "ok" | "drift_detected" | "inconsistent";
  authoritativeVersion: number;
  cachedVersion: number;
  latestKnownVersion: number;
  appliedVersions: number[];
  pendingVersions: number[];
  issues: string[];
}

export interface SchemaApplyResult {
  previousVersion: number;
  version: number;
  applied: number[];
}

export function pendingProjectSchemaVersions(currentVersion: number): ProjectSchemaMigration[] {
  if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error("invalid_schema_version");
  return projectSchemaMigrations.filter((migration) => migration.version > currentVersion);
}

/**
 * Reads the authoritative applied schema versions from the project's own D1 database.
 * The `mb_schema_versions` table in the project database is the single source of truth.
 */
export async function inspectProjectSchema(
  env: MiniBaseEnv,
  databaseId: string,
): Promise<ProjectSchemaState> {
  const tableCheck = await queryProjectD1<{ name: string }>(
    env,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mb_schema_versions'",
    [],
  );
  if (!tableCheck.results || tableCheck.results.length === 0) {
    return {
      authoritativeVersion: 0,
      appliedVersions: [],
      hasVersionTable: false,
      issues: [],
    };
  }

  const versionsQuery = await queryProjectD1<{ version: number; applied_at: string }>(
    env,
    databaseId,
    "SELECT version, applied_at FROM mb_schema_versions ORDER BY version ASC",
    [],
  );

  const appliedVersions = (versionsQuery.results ?? []).map((row) => row.version);
  const issues: string[] = [];

  if (appliedVersions.some((version) => !Number.isInteger(version) || version <= 0)) {
    issues.push("invalid_version_number");
  }

  const sorted = [...appliedVersions].filter((version) => Number.isInteger(version) && version > 0).sort((a, b) => a - b);
  const maxVersion = sorted.length > 0 ? sorted[sorted.length - 1] : 0;

  if (maxVersion > latestKnownProjectSchemaVersion) {
    issues.push("unknown_future_version");
  }

  for (let expected = 1; expected <= maxVersion; expected += 1) {
    if (!sorted.includes(expected)) {
      issues.push("missing_version_gap");
      break;
    }
  }

  const authoritativeVersion = issues.includes("missing_version_gap") || issues.includes("invalid_version_number")
    ? 0
    : maxVersion;

  return {
    authoritativeVersion,
    appliedVersions,
    hasVersionTable: true,
    issues,
  };
}

/**
 * Verifies the schema state of a project by comparing the authoritative version
 * in the project DB against the cached version in the control DB and known migrations.
 */
export async function verifyProjectSchema(
  env: MiniBaseEnv,
  projectId: string,
): Promise<ProjectSchemaVerification> {
  const project = await env.CONTROL_DB.prepare(
    "SELECT id, slug, d1_database_id, data_schema_version FROM projects WHERE id = ? AND status = 'active'",
  ).bind(projectId).first<{ id: string; slug: string; d1_database_id: string; data_schema_version: number }>();
  if (!project?.d1_database_id) throw new Error("project_not_found");

  const state = await inspectProjectSchema(env, project.d1_database_id);
  const issues = [...state.issues];

  if (!state.hasVersionTable && project.data_schema_version > 0) {
    issues.push("missing_schema_versions_table");
  }
  if (state.authoritativeVersion !== project.data_schema_version) {
    issues.push("control_version_mismatch");
  }

  let status: "ok" | "drift_detected" | "inconsistent" = "ok";
  if (
    issues.includes("missing_version_gap") ||
    issues.includes("unknown_future_version") ||
    issues.includes("invalid_version_number") ||
    (!state.hasVersionTable && project.data_schema_version > 0)
  ) {
    status = "inconsistent";
  } else if (issues.length > 0) {
    status = "drift_detected";
  }

  const pendingVersions = status === "inconsistent"
    ? []
    : pendingProjectSchemaVersions(state.authoritativeVersion).map((migration) => migration.version);

  return {
    projectId,
    status,
    authoritativeVersion: state.authoritativeVersion,
    cachedVersion: project.data_schema_version,
    latestKnownVersion: latestKnownProjectSchemaVersion,
    appliedVersions: state.appliedVersions,
    pendingVersions,
    issues,
  };
}

/**
 * Applies pending schema migrations to the project's D1 database.
 * The project database's own `mb_schema_versions` is the authoritative source of truth.
 * Control DB `projects.data_schema_version` is updated as a cache after migrations succeed.
 */
export async function applyProjectSchema(
  env: MiniBaseEnv,
  projectId: string,
  actorKeyId: string,
  correlationId?: string,
): Promise<SchemaApplyResult> {
  const project = await env.CONTROL_DB.prepare(
    "SELECT id, slug, d1_database_id, data_schema_version FROM projects WHERE id = ? AND status = 'active'",
  ).bind(projectId).first<{ id: string; slug: string; d1_database_id: string; data_schema_version: number }>();
  if (!project?.d1_database_id) throw new Error("project_not_found");

  const state = await inspectProjectSchema(env, project.d1_database_id);

  if (
    state.issues.includes("missing_version_gap") ||
    state.issues.includes("unknown_future_version") ||
    state.issues.includes("invalid_version_number") ||
    (!state.hasVersionTable && project.data_schema_version > 0)
  ) {
    throw new Error("inconsistent_schema_state");
  }

  const previousVersion = state.authoritativeVersion;
  const pending = pendingProjectSchemaVersions(previousVersion);

  if (pending.length === 0) {
    // Project database is already at the latest schema version.
    // If the control DB cached version drifted, sync it to match authoritative state.
    if (project.data_schema_version !== previousVersion) {
      await env.CONTROL_DB.prepare(
        "UPDATE projects SET data_schema_version = ?, updated_at = ? WHERE id = ?",
      ).bind(previousVersion, new Date().toISOString(), projectId).run();
    }
    return {
      previousVersion,
      version: previousVersion,
      applied: [],
    };
  }

  for (const migration of pending) {
    for (const sql of migration.statements) {
      await queryProjectD1(env, project.d1_database_id, sql, []);
    }
    await env.CONTROL_DB.prepare(
      "UPDATE projects SET data_schema_version = ?, updated_at = ? WHERE id = ?",
    ).bind(migration.version, new Date().toISOString(), projectId).run();
  }

  const finalVersion = pending.at(-1)?.version ?? previousVersion;
  const applied = pending.map((migration) => migration.version);

  await env.CONTROL_DB.prepare(
    `INSERT INTO audit_events
      (id, project_id, action, created_at, actor_key_id, outcome, metadata, entity, entity_id, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    projectId,
    "project.schema_applied",
    new Date().toISOString(),
    actorKeyId,
    "success",
    JSON.stringify({ previousVersion, version: finalVersion, applied }),
    "project",
    projectId,
    correlationId ?? null,
  ).run();

  return {
    previousVersion,
    version: finalVersion,
    applied,
  };
}
