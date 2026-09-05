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
  {
    /**
     * CP-06 files & artifact model.
     *
     * Extends `mb_files` with SHA-256, uploaded_at and optional entity link
     * for regular files (mutable, backward-compatible). Introduces
     * `mb_artifacts` for immutable originals in the reserved
     * `.mb_artifacts/originals/` R2 namespace. The two stores are deliberately
     * separate tables so file cursors and listings never need to hide internal
     * artifact rows.
     *
     * `mb_artifacts` is immutable: plain INSERT, no ON CONFLICT DO UPDATE.
     * `mb_files` keeps ON CONFLICT DO UPDATE for legacy mutable overwrite.
     *
     * All new columns are nullable or have CHECKs that allow NULL, so a populated
     * v6 database upgrades as a pure metadata operation without rewriting rows.
     * Re-applying v7 is safe; `IF NOT EXISTS` guards tables/indexes and
     * `INSERT OR IGNORE` guards the version row. `ALTER TABLE ... ADD COLUMN`
     * statements are retried safely by `applyProjectSchema` which ignores
     * "duplicate column name" errors from an interrupted run.
     */
    version: 7,
    statements: [
      "ALTER TABLE mb_files ADD COLUMN checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'))",
      "ALTER TABLE mb_files ADD COLUMN uploaded_at TEXT",
      "ALTER TABLE mb_files ADD COLUMN entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63 AND entity_type GLOB '[a-z]*' AND entity_type NOT GLOB '*[^a-z0-9_-]*' AND substr(entity_type,1,3) != 'mb_'))",
      "ALTER TABLE mb_files ADD COLUMN entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128 AND entity_id GLOB '[A-Za-z0-9]*' AND entity_id NOT GLOB '*[^A-Za-z0-9._:-]*'))",
      `CREATE TABLE IF NOT EXISTS mb_artifacts (
        artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 64 AND artifact_id GLOB '[A-Za-z0-9]*' AND artifact_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        storage_key TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL CHECK(size >= 0),
        content_type TEXT,
        etag TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'),
        uploaded_at TEXT NOT NULL,
        entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63 AND entity_type GLOB '[a-z]*' AND entity_type NOT GLOB '*[^a-z0-9_-]*' AND substr(entity_type,1,3) != 'mb_')),
        entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128 AND entity_id GLOB '[A-Za-z0-9]*' AND entity_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
        created_at TEXT NOT NULL,
        CHECK((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))
      )`,
      "CREATE INDEX IF NOT EXISTS mb_artifacts_uploaded_idx ON mb_artifacts(uploaded_at DESC)",
      "CREATE INDEX IF NOT EXISTS mb_artifacts_entity_idx ON mb_artifacts(entity_type, entity_id)",
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (7, datetime('now'))",
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
  if (!project || !project.d1_database_id) throw new Error("project_not_found");
  const projectDatabaseId = project.d1_database_id;

  const state = await inspectProjectSchema(env, projectDatabaseId);
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
/**
 * Physical V7 structure verification — without authoritative version row.
 *
 * Checks that the physical tables/columns/constraints for v7 exist with exact
 * expected shape. This is used inside migration apply BEFORE version 7 is
 * published, so it must NOT require SELECT version 7. If this fails,
 * version 7 must NOT be inserted and control cache must NOT be updated.
 */
export async function verifyV7PhysicalStructure(
  env: MiniBaseEnv,
  databaseId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    // Fetch CREATE TABLE sql for both tables
    const filesSqlRes = await queryProjectD1<{ sql: string }>(
      env,
      databaseId,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_files'",
      [],
    );
    const filesSql = filesSqlRes.results?.[0]?.sql ?? "";
    if (!filesSql) return { ok: false, reason: "missing_mb_files" };
    // Mandatory v7 columns + checks for mb_files
    const filesChecks = [
      "checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64",
      "uploaded_at TEXT",
      "entity_type TEXT CHECK(entity_type IS NULL OR",
      "entity_id TEXT CHECK(entity_id IS NULL OR",
    ];
    for (const needle of filesChecks) {
      if (!filesSql.includes(needle)) return { ok: false, reason: `mb_files_missing:${needle.slice(0, 20)}` };
    }

    const artifactsSqlRes = await queryProjectD1<{ sql: string }>(
      env,
      databaseId,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_artifacts'",
      [],
    );
    const artifactsSql = artifactsSqlRes.results?.[0]?.sql ?? "";
    if (!artifactsSql) return { ok: false, reason: "missing_mb_artifacts" };
    const artifactsChecks = [
      "artifact_id TEXT PRIMARY KEY",
      "storage_key TEXT NOT NULL UNIQUE",
      "checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256) = 64",
      "uploaded_at TEXT NOT NULL",
      "CHECK((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))",
    ];
    for (const needle of artifactsChecks) {
      if (!artifactsSql.includes(needle)) return { ok: false, reason: `mb_artifacts_missing:${needle.slice(0, 20)}` };
    }

    // Verify columns via PRAGMA table_info for exactness
    const filesInfo = await queryProjectD1<{ name: string; type: string; notnull: number; pk: number }>(
      env,
      databaseId,
      "PRAGMA table_info(mb_files)",
      [],
    );
    const filesCols = new Map((filesInfo.results ?? []).map((r) => [r.name, r]));
    for (const col of ["checksum_sha256", "uploaded_at", "entity_type", "entity_id"]) {
      if (!filesCols.has(col)) return { ok: false, reason: `pragma_mb_files_missing:${col}` };
    }
    if (filesCols.get("checksum_sha256")?.type !== "TEXT") return { ok: false, reason: "pragma_mb_files_wrong_type_checksum" };

    const artifactsInfo = await queryProjectD1<{ name: string; type: string; notnull: number; pk: number }>(
      env,
      databaseId,
      "PRAGMA table_info(mb_artifacts)",
      [],
    );
    const artifactsCols = new Map((artifactsInfo.results ?? []).map((r) => [r.name, r]));
    for (const col of ["artifact_id", "storage_key", "size", "etag", "checksum_sha256", "uploaded_at", "created_at"]) {
      if (!artifactsCols.has(col)) return { ok: false, reason: `pragma_mb_artifacts_missing:${col}` };
    }
    if (artifactsCols.get("artifact_id")?.pk !== 1) return { ok: false, reason: "pragma_mb_artifacts_no_pk" };
    if (artifactsCols.get("checksum_sha256")?.notnull !== 1) return { ok: false, reason: "pragma_mb_artifacts_checksum_not_null" };
    if (artifactsCols.get("uploaded_at")?.notnull !== 1) return { ok: false, reason: "pragma_mb_artifacts_uploaded_not_null" };

    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "cloudflare_api_error" || msg.includes("transport failed")) throw error;
    if (msg.includes("no such table") || msg.includes("no such column")) return { ok: false, reason: msg };
    throw error;
  }
}

/**
 * Precise V7 structure verification including authoritative version row.
 *
 * Old name kept for compatibility: now delegates to physical + version check.
 */
export async function verifyV7Structure(
  env: MiniBaseEnv,
  databaseId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const v7 = await queryProjectD1<{ version: number }>(
      env,
      databaseId,
      "SELECT version FROM mb_schema_versions WHERE version = 7 LIMIT 1",
      [],
    );
    if (!v7.results || v7.results.length === 0) return { ok: false, reason: "missing_version_7" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "cloudflare_api_error" || msg.includes("transport failed")) throw error;
    if (msg.includes("no such table") || msg.includes("no such column")) return { ok: false, reason: msg };
    throw error;
  }
  return verifyV7PhysicalStructure(env, databaseId);
}

export async function assertV7ReadyForWrite(
  env: MiniBaseEnv,
  databaseId: string,
): Promise<void> {
  const res = await verifyV7Structure(env, databaseId);
  if (!res.ok) throw new Error("file_schema_not_ready");
}

export async function applyProjectSchema(
  env: MiniBaseEnv,
  projectId: string,
  actorKeyId: string,
  correlationId?: string,
): Promise<SchemaApplyResult> {
  const project = await env.CONTROL_DB.prepare(
    "SELECT id, slug, d1_database_id, data_schema_version FROM projects WHERE id = ? AND status = 'active'",
  ).bind(projectId).first<{ id: string; slug: string; d1_database_id: string; data_schema_version: number }>();
  if (!project || !project.d1_database_id) throw new Error("project_not_found");
  const projectDatabaseId = project.d1_database_id;

  const state = await inspectProjectSchema(env, projectDatabaseId);

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
    if ((project as { data_schema_version: number }).data_schema_version !== previousVersion) {
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

  // Expected v7 ALTER statements — only these are allowed to be ignored on duplicate column name,
  // and only if the existing column has the expected shape. Any other duplicate is inconsistent.
  const expectedV7Alters = new Set([
    "ALTER TABLE mb_files ADD COLUMN checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'))",
    "ALTER TABLE mb_files ADD COLUMN uploaded_at TEXT",
    "ALTER TABLE mb_files ADD COLUMN entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63 AND entity_type GLOB '[a-z]*' AND entity_type NOT GLOB '*[^a-z0-9_-]*' AND substr(entity_type,1,3) != 'mb_'))",
    "ALTER TABLE mb_files ADD COLUMN entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128 AND entity_id GLOB '[A-Za-z0-9]*' AND entity_id NOT GLOB '*[^A-Za-z0-9._:-]*'))",
  ]);

  // Helper to execute a single statement with duplicate-column handling for v7
  async function execWithDuplicateHandling(sql: string): Promise<void> {
    try {
      await queryProjectD1(env, projectDatabaseId, sql, []);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("duplicate column name")) {
        if (!expectedV7Alters.has(sql)) throw new Error("inconsistent_schema_state");
        const colMatch = /ADD COLUMN\s+(\w+)/.exec(sql);
        const colName = colMatch?.[1];
        if (!colName) throw new Error("inconsistent_schema_state");
        try {
          const info = await queryProjectD1<{ name: string; type: string }>(
            env,
            projectDatabaseId,
            "PRAGMA table_info(mb_files)",
            [],
          );
          const col = (info.results ?? []).find((r) => r.name === colName);
          if (!col) throw new Error("inconsistent_schema_state");
          const expectedType: Record<string, string> = {
            checksum_sha256: "TEXT",
            uploaded_at: "TEXT",
            entity_type: "TEXT",
            entity_id: "TEXT",
          };
          if (col.type !== expectedType[colName]) throw new Error("inconsistent_schema_state");
          const sqlRes = await queryProjectD1<{ sql: string }>(
            env,
            projectDatabaseId,
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='mb_files'",
            [],
          );
          const tableSql = sqlRes.results?.[0]?.sql ?? "";
          if (colName === "checksum_sha256" && !tableSql.includes("checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64")) {
            throw new Error("inconsistent_schema_state");
          }
          if (colName === "entity_type" && !tableSql.includes("entity_type TEXT CHECK(entity_type IS NULL OR")) {
            throw new Error("inconsistent_schema_state");
          }
          if (colName === "entity_id" && !tableSql.includes("entity_id TEXT CHECK(entity_id IS NULL OR")) {
            throw new Error("inconsistent_schema_state");
          }
        } catch (inner) {
          const imsg = inner instanceof Error ? inner.message : String(inner);
          if (imsg === "inconsistent_schema_state") throw inner;
          if (imsg === "cloudflare_api_error" || imsg.includes("transport failed")) throw inner;
          throw new Error("inconsistent_schema_state");
        }
        return;
      }
      throw error;
    }
  }

  // Execute pending migrations: for <7 incrementally update control, for 7 defer version insertion
  let v7PhysicalStatementsExecuted = false;
  for (const migration of pending) {
    if (migration.version === 7) {
      // For v7, execute only physical statements (4 ALTERs + CREATE TABLE + 2 indexes), NOT the version INSERT
      const physicalStatements = migration.statements.filter(
        (s) => !(s.includes("INSERT OR IGNORE INTO mb_schema_versions") && s.includes("(7,")),
      );
      for (const sql of physicalStatements) {
        await execWithDuplicateHandling(sql);
      }
      v7PhysicalStatementsExecuted = true;
      // Do NOT yet insert version 7, do NOT yet update control DB — must verify physical first
      continue;
    }
    // For <7, execute all statements and incrementally update control
    for (const sql of migration.statements) {
      await execWithDuplicateHandling(sql);
    }
    await env.CONTROL_DB.prepare(
      "UPDATE projects SET data_schema_version = ?, updated_at = ? WHERE id = ?",
    ).bind(migration.version, new Date().toISOString(), projectId).run();
  }

  // If v7 was pending, perform exact physical verification BEFORE publishing version 7
  if (v7PhysicalStatementsExecuted) {
    const physical = await verifyV7PhysicalStructure(env, projectDatabaseId);
    if (!physical.ok) {
      // Physical verification failed: version 7 must NOT be present, control cache unchanged, next apply remains pending
      throw new Error("inconsistent_schema_state");
    }
    // Only after successful physical check, insert authoritative row version 7
    await queryProjectD1(
      env,
      projectDatabaseId,
      "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (7, datetime('now'))",
      [],
    );
    // Re-check authoritative state
    const postState = await inspectProjectSchema(env, projectDatabaseId);
    if (postState.authoritativeVersion !== 7) throw new Error("inconsistent_schema_state");
    const ready = await verifyV7Structure(env, projectDatabaseId);
    if (!ready.ok) throw new Error("inconsistent_schema_state");
    // Only now update control DB cache
    await env.CONTROL_DB.prepare(
      "UPDATE projects SET data_schema_version = ?, updated_at = ? WHERE id = ?",
    ).bind(7, new Date().toISOString(), projectId).run();
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
