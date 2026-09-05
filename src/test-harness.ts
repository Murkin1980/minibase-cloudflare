import type { MiniBaseEnv, R2Object } from "./contracts";
import type { LimitOverrides } from "./limits";
import type { QuotaKey } from "./project-quotas";
import type { RouteClass } from "./abuse-control";
import { sha256 } from "./security";
// @ts-expect-error — Node types not installed for test polyfill only
import { createHash } from "node:crypto";

// Polyfill workerd DigestStream for Node vitest — production file-hash.ts
// must remain free of Node code so the Worker bundle stays minimal.
// This polyfill lives only in the test harness and is never bundled for Workers.
if (typeof globalThis.crypto !== "undefined" && !("DigestStream" in (globalThis.crypto as unknown as Record<string, unknown>))) {
  class NodeDigestStream extends WritableStream<Uint8Array> {
    digest: Promise<ArrayBuffer>;
    private _hash = createHash("sha256");
    private _resolve!: (v: ArrayBuffer) => void;
    private _reject!: (e: unknown) => void;
    constructor(_alg: string) {
      void _alg;
      let resolve!: (v: ArrayBuffer) => void;
      let reject!: (e: unknown) => void;
      const digestPromise = new Promise<ArrayBuffer>((res, rej) => { resolve = res; reject = rej; });
      super({
        write: (chunk: Uint8Array) => { try { (this as unknown as NodeDigestStream)._hash.update(chunk); } catch (e) { reject(e); throw e; } },
        close: () => {
          try {
            const buf = (this as unknown as NodeDigestStream)._hash.digest();
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
            resolve(ab);
          } catch (e) { reject(e); }
        },
        abort: (reason) => { reject(reason instanceof Error ? reason : new Error(String(reason))); },
      });
      this.digest = digestPromise;
      this._resolve = resolve;
      this._reject = reject;
    }
  }
  (globalThis.crypto as unknown as Record<string, unknown>)["DigestStream"] = NodeDigestStream as unknown as never;
}

/**
 * Shared test double for the whole MiniBase request path.
 *
 * It stands in for three real things: the control D1, the Cloudflare D1 HTTP API
 * that fronts each project database, and the shared R2 bucket.
 *
 * What it deliberately does NOT do is re-implement SQLite. The keyset query
 * below is a minimal model of the exact statement MiniBase sends, so these tests
 * verify MiniBase's own routing, parameter binding, cursor arithmetic, page
 * slicing, isolation prefixing, and audit writes — not SQLite's query planner.
 * Statements that depend on a real engine are covered against real D1/SQLite by
 * `scripts/test-d1.mjs`, `src/query-index.test.ts`, and
 * `src/commands.integration.test.ts`.
 */

export interface HarnessProject {
  projectId: string;
  databaseId: string;
  slug: string;
  name?: string;
  origins?: string[];
  status?: string;
  dataSchemaVersion?: number;
  schemaVersions?: number[];
  hasSchemaVersionsTable?: boolean;
  /**
   * CP-05 partial-v6-migration fixtures. In production the v6 table, trigger,
   * and authoritative version row are installed in that order. These switches
   * let route tests prove that an incomplete installation fails closed.
   */
  commandTablePresent?: boolean;
  commandTriggerPresent?: boolean;
  /** CP-03 stored per-project quotas. Omitted means NULL, i.e. inherit the deployment ceiling. */
  quotas?: Partial<Record<QuotaKey, number | null>>;
}

export interface HarnessDataKey {
  key: string;
  projectId: string;
  kind: "publishable" | "secret";
  scopes: string[];
  revoked?: boolean;
  expiresAt?: string;
}

export interface HarnessManagementKey {
  key: string;
  keyId?: string;
  scopes: string[];
}

export interface HarnessOptions {
  projects?: HarnessProject[];
  dataKeys?: HarnessDataKey[];
  managementKeys?: HarnessManagementKey[];
  limits?: LimitOverrides;
  rateLimitSuccess?: boolean;
  /** CP-03: declare one binding per route class instead of the single shared one. */
  perRouteRateLimiters?: boolean;
  /** CP-03: declare no rate-limit binding at all. */
  omitRateLimiters?: boolean;
  /** CP-03: deny only these route classes, proving their periods are independent. */
  rateLimitDeniedRoutes?: RouteClass[];
  /** CP-03: deny only these projects' buckets, proving per-project isolation. */
  rateLimitDeniedProjects?: string[];
  /** CP-03: the deployment demands a resolvable limiter (fail-closed switch). */
  rateLimiterRequired?: boolean;
  /**
   * Simulates an outbound project-D1 transport failure before SQLite receives
   * the statement. Used to prove a failed transport cannot create a marker.
   */
  failProjectD1Requests?: number;
  /** CP-06: fail only the next N artifact INSERTs to test orphan handling */
  failArtifactInsertRequests?: number;
}

/** One observed rate-limit consultation, with the binding that served it. */
export interface HarnessRateLimitCall {
  binding: "RATE_LIMITER" | "RATE_LIMITER_CONTROL" | "RATE_LIMITER_DATA" | "RATE_LIMITER_FILES";
  key: string;
}

export interface RecordRow {
  id: string;
  data: string;
  created_at: string;
  updated_at: string;
}

export interface FileMeta {
  size: number;
  contentType: string;
  etag: string;
  sha256?: string | null;
  uploadedAt?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export interface ArtifactMeta {
  artifactId: string;
  storageKey: string;
  size: number;
  contentType: string | null;
  etag: string;
  sha256: string;
  uploadedAt: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

/** CP-05 persisted marker, keyed by command type + SHA-256 idempotency key. */
export interface HarnessCommandRow {
  command_id: string;
  command_type: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  normalized_payload: string;
  response_json: string;
  status: string;
  created_at: string;
  completed_at: string;
}

export interface AuditRow {
  sql: string;
  values: unknown[];
}

export interface D1Call {
  databaseId: string;
  sql: string;
  params: unknown[];
}

export interface HarnessProjectRow extends StoredQuotas {
  id: string;
  slug: string;
  name: string;
  status: string;
  d1_database_id: string;
  data_schema_version: number;
  origins: string[];
}

/** The `projects.quota_*` columns added by `migrations/0008_project_quotas.sql`. */
export interface StoredQuotas {
  quota_max_json_bytes: number | null;
  quota_max_file_bytes: number | null;
  quota_max_page_size: number | null;
  quota_max_bulk_records: number | null;
}

function storedQuotas(quotas: HarnessProject["quotas"]): StoredQuotas {
  return {
    quota_max_json_bytes: quotas?.maxJsonBytes ?? null,
    quota_max_file_bytes: quotas?.maxFileBytes ?? null,
    quota_max_page_size: quotas?.maxPageSize ?? null,
    quota_max_bulk_records: quotas?.maxBulkRecords ?? null,
  };
}

export interface HarnessSchemaState {
  hasTable: boolean;
  versions: number[];
  commandTablePresent: boolean;
  commandTriggerPresent: boolean;
  v7PhysicalApplied?: boolean;
}

export interface Harness {
  env: MiniBaseEnv;
  audit: AuditRow[];
  /** database id -> collection -> record id -> row */
  records: Map<string, Map<string, Map<string, RecordRow>>>;
  /** database id -> command type/key-hash -> persisted marker */
  commands: Map<string, Map<string, HarnessCommandRow>>;
  /** database id -> collection/id -> number of trigger-applied record mutations */
  commandMutations: Map<string, Map<string, number>>;
  /** database id -> path -> metadata */
  files: Map<string, Map<string, FileMeta>>;
  /** database id -> artifactId -> metadata */
  artifacts: Map<string, Map<string, ArtifactMeta>>;
  /** database id -> schema state */
  schemaStore: Map<string, HarnessSchemaState>;
  /** project id -> project row */
  projectRows: Map<string, HarnessProjectRow>;
  r2Keys: string[];
  d1Calls: D1Call[];
  controlSql: string[];
  /** CP-03: every rate-limit consultation, with the binding that answered it. */
  rateLimitCalls: HarnessRateLimitCall[];
  request(path: string, init?: RequestInit): Promise<Response>;
  dispose(): void;
}

const D1_QUERY = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/query$/;

const NOW = "2026-09-03T00:00:00Z";


/**
 * Evaluates the CP-04 list statement the way SQLite would, for the harness only.
 *
 * This is still a model, not an engine: it accepts exactly the static shapes
 * `buildRecordStatement` can emit and throws on anything else, so a change to
 * the query builder that widens the SQL surface fails these tests loudly
 * instead of being silently modelled. Whether a real planner uses the intended
 * index is proven separately, against real SQLite, in `src/query-index.test.ts`.
 */
function selectRecords(
  store: Map<string, Map<string, RecordRow>>,
  flat: string,
  params: unknown[],
): RecordRow[] {
  const whereSql = flat.slice(flat.indexOf("WHERE ") + 6, flat.indexOf(" ORDER BY "));
  const orderSql = flat.slice(flat.indexOf(" ORDER BY ") + 10, flat.lastIndexOf(" LIMIT ?"));
  const conditions = whereSql.split(" AND ");
  const values = [...params];
  const collection = String(values.shift());
  const limit = Number(values.pop());

  const columnOf = (row: RecordRow, sql: string): string | number | null => {
    if (sql === "id") return row.id;
    if (sql === "created_at") return row.created_at;
    if (sql === "updated_at") return row.updated_at;
    if (sql === "json_extract(data, '$.schemaVersion')") {
      const value = (JSON.parse(row.data) as { schemaVersion?: unknown }).schemaVersion;
      return typeof value === "number" || typeof value === "string" ? value : null;
    }
    throw new Error(`harness: unmodelled column expression: ${sql}`);
  };

  const compare = (left: string | number | null, operator: string, right: unknown): boolean => {
    if (left === null || right === null || right === undefined) return false;
    switch (operator) {
      case "=": return left === right;
      case ">": return left > (right as typeof left);
      case ">=": return left >= (right as typeof left);
      case "<": return left < (right as typeof left);
      case "<=": return left <= (right as typeof left);
      default: throw new Error(`harness: unmodelled operator: ${operator}`);
    }
  };

  let rows = [...(store.get(collection) ?? new Map<string, RecordRow>()).values()];
  for (const condition of conditions.slice(1)) {
    const rowValue = /^\(.+ , id\) (<|>) \(\?, \?\)$/.exec(condition) ?? /^\((.+), id\) (<|>) \(\?, \?\)$/.exec(condition);
    if (rowValue) {
      const [sortValue, id] = [values.shift(), String(values.shift())];
      const operator = rowValue[2];
      rows = rows.filter((row) => {
        const left = columnOf(row, rowValue[1]);
        if (left === sortValue) return compare(row.id, operator, id);
        return compare(left, operator, sortValue);
      });
      continue;
    }
    const simple = /^(.+) (=|>=|<=|>|<) \?$/.exec(condition);
    if (!simple) throw new Error(`harness: unmodelled condition: ${condition}`);
    const bound = values.shift();
    rows = rows.filter((row) => compare(columnOf(row, simple[1]), simple[2], bound));
  }

  const terms = orderSql.split(", ").map((term) => {
    const [sql, direction] = term.split(" ");
    return { sql, descending: direction === "DESC" };
  });
  rows.sort((left, right) => {
    for (const term of terms) {
      const a = columnOf(left, term.sql);
      const b = columnOf(right, term.sql);
      if (a === b) continue;
      const order = (a as never) < (b as never) ? -1 : 1;
      return term.descending ? -order : order;
    }
    return 0;
  });
  return rows.slice(0, limit);
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const projects = options.projects ?? [];
  const records = new Map<string, Map<string, Map<string, RecordRow>>>();
  const commands = new Map<string, Map<string, HarnessCommandRow>>();
  const commandMutations = new Map<string, Map<string, number>>();
  const files = new Map<string, Map<string, FileMeta>>();
  const artifacts = new Map<string, Map<string, ArtifactMeta>>();
  const schemaStore = new Map<string, HarnessSchemaState>();
  const projectRows = new Map<string, HarnessProjectRow>();
  const r2Bodies = new Map<string, string>();
  const r2Meta = new Map<string, { size: number; etag: string; uploaded: Date; contentType?: string }>();
  const r2Keys: string[] = [];
  const audit: AuditRow[] = [];
  const d1Calls: D1Call[] = [];
  const controlSql: string[] = [];
  const rateLimitCalls: HarnessRateLimitCall[] = [];

  for (const project of projects) {
    const schemaVersions = project.schemaVersions ? [...project.schemaVersions] : [1, 2, 3, 4, 5, 6, 7];
    const hasCommandV6 = schemaVersions.includes(6);
    records.set(project.databaseId, new Map());
    commands.set(project.databaseId, new Map());
    commandMutations.set(project.databaseId, new Map());
    files.set(project.databaseId, new Map());
    artifacts.set(project.databaseId, new Map());
    projectRows.set(project.projectId, {
      id: project.projectId,
      slug: project.slug,
      name: project.name ?? project.slug,
      status: project.status ?? "active",
      d1_database_id: project.databaseId,
      data_schema_version: project.dataSchemaVersion ?? 7,
      origins: project.origins ?? [],
      ...storedQuotas(project.quotas),
    });
    schemaStore.set(project.databaseId, {
      hasTable: project.hasSchemaVersionsTable !== false,
      versions: schemaVersions,
      commandTablePresent: project.commandTablePresent ?? hasCommandV6,
      commandTriggerPresent: project.commandTriggerPresent ?? hasCommandV6,
      v7PhysicalApplied: schemaVersions.includes(7),
    });
  }

  const dataKeyRows = new Map<string, {
    id: string; project_id: string; kind: string; scopes: string;
    expires_at: string | null; revoked_at: string | null;
    d1_database_id: string; status: string; last_used_at: string | null;
  } & StoredQuotas>();
  const managementKeyRows = new Map<string, {
    id: string; scopes: string; expires_at: null; revoked_at: null;
  }>();

  const ready = Promise.all([
    ...(options.dataKeys ?? []).map(async (key, index) => {
      const project = projects.find((candidate) => candidate.projectId === key.projectId);
      if (!project) throw new Error(`harness: unknown project ${key.projectId}`);
      dataKeyRows.set(await sha256(key.key), {
        id: `data-key-${index}`,
        project_id: key.projectId,
        kind: key.kind,
        scopes: key.scopes.join(","),
        expires_at: key.expiresAt ?? null,
        revoked_at: key.revoked ? "2020-01-01T00:00:00Z" : null,
        d1_database_id: project.databaseId,
        status: project.status ?? "active",
        last_used_at: null,
        // The authentication query joins `projects`, so the harness must present
        // the quota columns exactly as that join does.
        ...storedQuotas(project.quotas),
      });
    }),
    ...(options.managementKeys ?? []).map(async (key, index) => {
      managementKeyRows.set(await sha256(key.key), {
        id: key.keyId ?? `management-key-${index}`,
        scopes: key.scopes.join(","),
        expires_at: null,
        revoked_at: null,
      });
    }),
  ]);

  function auditEventFrom(row: AuditRow) {
    const [id, projectId, action, createdAt, actorKeyId, outcome, metadata, entity, entityId, correlationId] =
      row.values as [string, string, string, string, string, string, string, string, string, string];
    return {
      id, project_id: projectId, action, created_at: createdAt, actor_key_id: actorKeyId,
      outcome, metadata, entity, entity_id: entityId, correlation_id: correlationId,
    };
  }

  /**
   * Applies a CP-03 quota update to the modelled control rows.
   *
   * Both `projects` and the joined `api_keys` view are updated, because the
   * data-plane authentication query reads quotas through that join: a test that
   * replaces a quota and then issues a data request must see the new ceiling on
   * the very next request.
   */
  function applyQuotaUpdate(values: unknown[]) {
    const [maxJsonBytes, maxFileBytes, maxPageSize, maxBulkRecords, , projectId] = values as [
      number | null, number | null, number | null, number | null, string, string,
    ];
    const row = projectRows.get(String(projectId));
    if (!row) return;
    row.quota_max_json_bytes = maxJsonBytes ?? null;
    row.quota_max_file_bytes = maxFileBytes ?? null;
    row.quota_max_page_size = maxPageSize ?? null;
    row.quota_max_bulk_records = maxBulkRecords ?? null;
    for (const keyRow of dataKeyRows.values()) {
      if (keyRow.project_id !== String(projectId)) continue;
      keyRow.quota_max_json_bytes = row.quota_max_json_bytes;
      keyRow.quota_max_file_bytes = row.quota_max_file_bytes;
      keyRow.quota_max_page_size = row.quota_max_page_size;
      keyRow.quota_max_bulk_records = row.quota_max_bulk_records;
    }
  }

  function statement(sql: string) {
    controlSql.push(sql);
    let values: unknown[] = [];
    const prepared = {
      sql,
      boundValues: () => values,
      bind(...bound: unknown[]) {
        values = bound;
        return prepared;
      },
      async first() {
        await ready;
        if (sql.includes("FROM api_keys k")) {
          const row = dataKeyRows.get(String(values[0]));
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM management_keys")) return managementKeyRows.get(String(values[0])) ?? null;
        if (sql.includes("FROM project_origins")) {
          const project = projectRows.get(String(values[0]));
          return project?.origins?.includes(String(values[1])) ? { allowed: 1 } : null;
        }
        if (sql.includes("FROM projects WHERE id =")) {
          const row = projectRows.get(String(values[0]));
          if (!row) return null;
          if (sql.includes("status = 'active'") && row.status !== "active") return null;
          return {
            id: row.id,
            slug: row.slug,
            d1_database_id: row.d1_database_id,
            data_schema_version: row.data_schema_version,
            status: row.status,
            quota_max_json_bytes: row.quota_max_json_bytes,
            quota_max_file_bytes: row.quota_max_file_bytes,
            quota_max_page_size: row.quota_max_page_size,
            quota_max_bulk_records: row.quota_max_bulk_records,
          };
        }
        return null;
      },
      async all() {
        await ready;
        if (sql.includes("FROM audit_events")) {
          const limit = Number(values.at(-1));
          return {
            success: true,
            results: audit.slice(-limit).reverse().map(auditEventFrom),
          };
        }
        return { success: true, results: [] };
      },
      async run() {
        await ready;
        if (sql.includes("INSERT INTO audit_events")) audit.push({ sql, values });
        if (sql.includes("UPDATE api_keys SET last_used_at")) {
          for (const row of dataKeyRows.values()) {
            if (row.id === values[1]) row.last_used_at = String(values[0]);
          }
        }
        if (sql.includes("UPDATE projects") && sql.includes("quota_max_json_bytes")) {
          applyQuotaUpdate(values);
        }
        if (sql.includes("UPDATE projects SET data_schema_version =")) {
          const nextVersion = Number(values[0]);
          const projectId = String(values[2]);
          const row = projectRows.get(projectId);
          if (row) {
            row.data_schema_version = nextVersion;
          }
        }
        return { success: true, results: [] };
      },
    };
    return prepared;
  }

  function r2Object(key: string, body: string, meta?: { size?: number; etag?: string; uploaded?: Date }): R2Object {
    const size = meta?.size ?? new TextEncoder().encode(body).byteLength;
    const etag = meta?.etag ?? `etag-${key.length}-${size}`;
    return {
      key,
      size,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: meta?.uploaded ?? new Date(),
      writeHttpMetadata() {},
    } as unknown as R2Object;
  }

  function isV7(databaseId: string): boolean {
    const s = schemaStore.get(databaseId);
    return !!s?.versions.includes(7);
  }

  function executeProjectSql(databaseId: string, sql: string, params: unknown[]) {
    const store = records.get(databaseId);
    const commandStore = commands.get(databaseId);
    const mutationStore = commandMutations.get(databaseId);
    const fileStore = files.get(databaseId);
    const artifactStore = artifacts.get(databaseId);
    const schema = schemaStore.get(databaseId);
    if (!store || !commandStore || !mutationStore || !fileStore || !artifactStore) return null;
    const flat = sql.replace(/\s+/g, " ");

    // Handle v7 schema probing and migration statements
    if (flat.includes("ALTER TABLE mb_files ADD COLUMN")) {
      if (schema) schema.v7PhysicalApplied = true;
      // Idempotent: if column already exists in v7, real SQLite would error duplicate column name.
      // Our project-schema now catches duplicate column name; simulate success always.
      return { results: [], success: true };
    }
    if (flat.includes("CREATE TABLE IF NOT EXISTS mb_artifacts")) {
      if (schema) schema.v7PhysicalApplied = true;
      return { results: [], success: true };
    }
    if (flat.includes("CREATE INDEX IF NOT EXISTS idx_mb_artifacts_storage_key") || flat.includes("CREATE INDEX IF NOT EXISTS idx_mb_artifacts_entity")) {
      return { results: [], success: true };
    }
    if (flat.startsWith("SELECT name FROM sqlite_master") && flat.includes("mb_artifacts")) {
      // Artifact table existence check for v7 probe
      return {
        results: isV7(databaseId) ? [{ name: "mb_artifacts" }] : [],
        success: true,
      };
    }
    if (flat.includes("FROM sqlite_master WHERE type = 'table' AND name = 'mb_schema_versions'")) {
      return {
        results: schema?.hasTable ? [{ name: "mb_schema_versions" }] : [],
        success: true,
      };
    }
    // This must not intercept INSERT INTO mb_commands which contains a SELECT subquery on mb_schema_versions.
    // Only handle top-level SELECT version ... queries (artifact schema probe).
    if (flat.startsWith("SELECT version FROM mb_schema_versions WHERE version")) {
      let wanted: number | null = null;
      if (params.length > 0 && typeof params[0] === "number") wanted = params[0] as number;
      else if (flat.includes("version = 7")) wanted = 7;
      else {
        const m = /version\s*=\s*(\d+)/.exec(flat);
        if (m) wanted = Number(m[1]);
      }
      if (wanted !== null) {
        const has = schema?.versions.includes(wanted);
        return { results: has ? [{ version: wanted, applied_at: NOW }] : [], success: true };
      }
    }
    if (flat.includes("FROM mb_schema_versions ORDER BY version ASC")) {
      if (!schema?.hasTable) {
        return null;
      }
      return {
        results: (schema.versions ?? []).map((version) => ({ version, applied_at: NOW })),
        success: true,
      };
    }
    if (flat.includes("CREATE TABLE IF NOT EXISTS mb_schema_versions")) {
      if (schema) schema.hasTable = true;
      return { results: [], success: true };
    }
    if (flat.includes("INSERT OR IGNORE INTO mb_schema_versions")) {
      if (schema) {
        const match = /VALUES\s*\(\s*(\d+)/i.exec(flat);
        const version = match ? Number(match[1]) : (typeof params[0] === "number" ? params[0] : null);
        if (version !== null && !schema.versions.includes(version)) {
          schema.versions.push(version);
          schema.versions.sort((a, b) => a - b);
        }
      }
      return { results: [], success: true };
    }
    if (flat.includes("CREATE TABLE IF NOT EXISTS mb_commands")) {
      if (schema) schema.commandTablePresent = true;
      return { results: [], success: true };
    }
    if (flat.includes("CREATE TRIGGER IF NOT EXISTS mb_commands_records_upsert_many_apply")) {
      if (schema) schema.commandTriggerPresent = true;
      return { results: [], success: true };
    }
    if (flat.startsWith("CREATE TABLE IF NOT EXISTS") || flat.startsWith("CREATE INDEX IF NOT EXISTS")) {
      return { results: [], success: true };
    }
    if (flat.startsWith("INSERT INTO mb_commands")) {
      // The exact v6 statement contains the authoritative version and trigger
      // checks in its SELECT. A missing table would make SQLite reject the SQL;
      // an incomplete installation with the table but no trigger/version selects
      // no row and therefore cannot create a command marker.
      if (!schema?.hasTable || !schema.commandTablePresent) return null;
      if (!schema.commandTriggerPresent || !schema.versions.includes(6)) {
        return { results: [], success: true };
      }
      const [
        commandId,
        commandType,
        idempotencyKeyHash,
        requestFingerprint,
        normalizedPayload,
        responseJson,
        status,
        createdAt,
        completedAt,
      ] = params;
      if (
        typeof commandId !== "string" || typeof commandType !== "string" ||
        typeof idempotencyKeyHash !== "string" || typeof requestFingerprint !== "string" ||
        typeof normalizedPayload !== "string" || typeof responseJson !== "string" ||
        typeof status !== "string" || typeof createdAt !== "string" || typeof completedAt !== "string"
      ) {
        return null;
      }
      const key = `${commandType}\u0000${idempotencyKeyHash}`;
      const existing = commandStore.get(key);
      if (existing) {
        return {
          results: [{
            command_id: existing.command_id,
            request_fingerprint: existing.request_fingerprint,
            response_json: existing.response_json,
            status: existing.status,
          }],
          success: true,
        };
      }

      // The route parser has already validated this canonical payload. Validate
      // the minimal trigger shape before making any modelled mutation so the
      // harness preserves SQLite's all-or-nothing statement behaviour.
      let operations: Array<{ collection: string; id: string; data: Record<string, unknown> }>;
      try {
        const payload = JSON.parse(normalizedPayload) as { operations?: unknown };
        if (!Array.isArray(payload.operations) || payload.operations.length < 1 || payload.operations.length > 1000) {
          return null;
        }
        operations = payload.operations.map((operation) => {
          if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("invalid operation");
          const candidate = operation as Record<string, unknown>;
          if (typeof candidate.collection !== "string" || typeof candidate.id !== "string" ||
            !candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) {
            throw new Error("invalid operation");
          }
          return {
            collection: candidate.collection,
            id: candidate.id,
            data: candidate.data as Record<string, unknown>,
          };
        });
      } catch {
        return null;
      }

      for (const operation of operations) {
        const existingRecord = store.get(operation.collection)?.get(operation.id);
        if (!store.has(operation.collection)) store.set(operation.collection, new Map());
        store.get(operation.collection)!.set(operation.id, {
          id: operation.id,
          data: JSON.stringify(operation.data),
          created_at: existingRecord?.created_at ?? createdAt,
          updated_at: completedAt,
        });
        const target = `${operation.collection}\u0000${operation.id}`;
        mutationStore.set(target, (mutationStore.get(target) ?? 0) + 1);
      }
      const stored: HarnessCommandRow = {
        command_id: commandId,
        command_type: commandType,
        idempotency_key_hash: idempotencyKeyHash,
        request_fingerprint: requestFingerprint,
        normalized_payload: normalizedPayload,
        response_json: responseJson,
        status,
        created_at: createdAt,
        completed_at: completedAt,
      };
      commandStore.set(key, stored);
      return {
        results: [{
          command_id: stored.command_id,
          request_fingerprint: stored.request_fingerprint,
          response_json: stored.response_json,
          status: stored.status,
        }],
        success: true,
      };
    }
    if (flat.includes("DELETE FROM mb_records")) {
      const [collection, id] = params as [string, string];
      store.get(collection)?.delete(id);
      return { results: [], success: true };
    }
    if (flat.includes("DELETE FROM mb_files")) {
      fileStore.delete(String(params[0]));
      return { results: [], success: true };
    }
    if (flat.includes("DELETE FROM mb_artifacts")) {
      artifactStore.delete(String(params[0]));
      return { results: [], success: true };
    }
    if (flat.includes("FROM mb_records WHERE collection = ? AND id = ?")) {
      const [collection, id] = params as [string, string];
      const row = store.get(collection)?.get(id);
      return { results: row ? [row] : [], success: true };
    }
    if (flat.startsWith("SELECT id, data, created_at, updated_at FROM mb_records WHERE collection = ?")) {
      return { results: selectRecords(store, flat, params), success: true };
    }
    if (flat.includes("INSERT INTO mb_records")) {
      const [collection, id, data, createdAt, updatedAt] =
        params as [string, string, string, string, string];
      const existing = store.get(collection)?.get(id);
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(id, {
        id, data, created_at: existing?.created_at ?? createdAt, updated_at: updatedAt,
      });
      return { results: [], success: true };
    }
    // --- Artifact queries ---
    // Simulate missing table when v7 not applied — but allow physical checks after ALTERs before version row
    const referencesArtifactTable = flat.includes("mb_artifacts") && !flat.includes("sqlite_master");
    if (referencesArtifactTable && !isV7(databaseId) && !schemaStore.get(databaseId)?.v7PhysicalApplied) {
      throw Object.assign(new Error("no such table: mb_artifacts"), { code: "SQLITE_ERROR" });
    }
    // V7 verification support: SELECT sql FROM sqlite_master for mb_files/mb_artifacts
    if (flat.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_files'")) {
      const s = schemaStore.get(databaseId);
      if (!isV7(databaseId) && !s?.v7PhysicalApplied) return { results: [], success: true };
      const sql = `CREATE TABLE mb_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT, etag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checksum_sha256 TEXT CHECK(checksum_sha256 IS NULL OR (length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*')), uploaded_at TEXT, entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63 AND entity_type GLOB '[a-z]*' AND entity_type NOT GLOB '*[^a-z0-9_-]*' AND substr(entity_type,1,3) != 'mb_')), entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128 AND entity_id GLOB '[A-Za-z0-9]*' AND entity_id NOT GLOB '*[^A-Za-z0-9._:-]*')))`;
      return { results: [{ sql }], success: true };
    }
    if (flat.includes("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mb_artifacts'")) {
      const s2 = schemaStore.get(databaseId);
      if (!isV7(databaseId) && !s2?.v7PhysicalApplied) return { results: [], success: true };
      const sql = `CREATE TABLE mb_artifacts (artifact_id TEXT PRIMARY KEY CHECK(length(artifact_id) BETWEEN 1 AND 64 AND artifact_id GLOB '[A-Za-z0-9]*' AND artifact_id NOT GLOB '*[^A-Za-z0-9._-]*'), storage_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size >= 0), content_type TEXT, etag TEXT NOT NULL, checksum_sha256 TEXT NOT NULL CHECK(length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'), uploaded_at TEXT NOT NULL, entity_type TEXT CHECK(entity_type IS NULL OR (length(entity_type) BETWEEN 2 AND 63 AND entity_type GLOB '[a-z]*' AND entity_type NOT GLOB '*[^a-z0-9_-]*' AND substr(entity_type,1,3) != 'mb_')), entity_id TEXT CHECK(entity_id IS NULL OR (length(entity_id) BETWEEN 1 AND 128 AND entity_id GLOB '[A-Za-z0-9]*' AND entity_id NOT GLOB '*[^A-Za-z0-9._:-]*')), created_at TEXT NOT NULL, CHECK((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL)))`;
      return { results: [{ sql }], success: true };
    }
    if (flat.startsWith("PRAGMA table_info(mb_files)")) {
      const s3 = schemaStore.get(databaseId);
      if (!isV7(databaseId) && !s3?.v7PhysicalApplied) {
        return { results: [
          { name: "path", type: "TEXT", notnull: 1, pk: 1 },
          { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "content_type", type: "TEXT", notnull: 0, pk: 0 },
          { name: "etag", type: "TEXT", notnull: 1, pk: 0 },
          { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
        ], success: true };
      }
      return { results: [
        { name: "path", type: "TEXT", notnull: 1, pk: 1 },
        { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "content_type", type: "TEXT", notnull: 0, pk: 0 },
        { name: "etag", type: "TEXT", notnull: 1, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "checksum_sha256", type: "TEXT", notnull: 0, pk: 0 },
        { name: "uploaded_at", type: "TEXT", notnull: 0, pk: 0 },
        { name: "entity_type", type: "TEXT", notnull: 0, pk: 0 },
        { name: "entity_id", type: "TEXT", notnull: 0, pk: 0 },
      ], success: true };
    }
    if (flat.startsWith("PRAGMA table_info(mb_artifacts)")) {
      const s4 = schemaStore.get(databaseId);
      if (!isV7(databaseId) && !s4?.v7PhysicalApplied) return { results: [], success: true };
      return { results: [
        { name: "artifact_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "storage_key", type: "TEXT", notnull: 1, pk: 0 },
        { name: "size", type: "INTEGER", notnull: 1, pk: 0 },
        { name: "content_type", type: "TEXT", notnull: 0, pk: 0 },
        { name: "etag", type: "TEXT", notnull: 1, pk: 0 },
        { name: "checksum_sha256", type: "TEXT", notnull: 1, pk: 0 },
        { name: "uploaded_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "entity_type", type: "TEXT", notnull: 0, pk: 0 },
        { name: "entity_id", type: "TEXT", notnull: 0, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
      ], success: true };
    }
    const referencesNewFileColumns = flat.includes("checksum_sha256") || flat.includes("uploaded_at") || flat.includes("entity_type") || flat.includes("entity_id");
    // For file queries that reference new columns, if v7 not present, simulate missing column
    if (referencesNewFileColumns && flat.includes("mb_files") && !isV7(databaseId)) {
      // Only for queries that select/insert those columns; schema check SELECTs for mb_artifacts already handled above
      if (flat.includes("INSERT INTO mb_files") && flat.includes("checksum_sha256")) {
        throw Object.assign(new Error("no such column: checksum_sha256"), { code: "SQLITE_ERROR" });
      }
      if (flat.includes("SELECT") && flat.includes("checksum_sha256")) {
        throw Object.assign(new Error("no such column: checksum_sha256"), { code: "SQLITE_ERROR" });
      }
    }

    // File list/select
    if (flat.includes("FROM mb_files WHERE path > ?")) {
      const [after, limit] = params as [string, number];
      const rows = [...fileStore.entries()]
        .filter(([path]) => path > after)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .slice(0, limit)
        .map(([path, meta]) => ({
          path, size: meta.size, content_type: meta.contentType, etag: meta.etag,
          checksum_sha256: meta.sha256 ?? null,
          uploaded_at: meta.uploadedAt ?? null,
          entity_type: meta.entityType ?? null,
          entity_id: meta.entityId ?? null,
          created_at: NOW, updated_at: meta.uploadedAt ?? NOW,
        }));
      return { results: rows, success: true };
    }
    if (flat.includes("FROM mb_files WHERE path = ?")) {
      const path = String(params[0]);
      const meta = fileStore.get(path);
      if (!meta) return { results: [], success: true };
      // Distinguish SELECT that expects new columns vs legacy
      if (flat.includes("checksum_sha256")) {
        return {
          results: [{ path, size: meta.size, content_type: meta.contentType, etag: meta.etag, checksum_sha256: meta.sha256 ?? null, uploaded_at: meta.uploadedAt ?? null, entity_type: meta.entityType ?? null, entity_id: meta.entityId ?? null, created_at: NOW, updated_at: meta.uploadedAt ?? NOW }],
          success: true,
        };
      }
      return {
        results: [{ path, size: meta.size, content_type: meta.contentType, etag: meta.etag, created_at: NOW, updated_at: NOW }],
        success: true,
      };
    }
    // Support SELECT path FROM mb_files ORDER BY path LIMIT etc. for reconcile
    if (flat.includes("SELECT path FROM mb_files ORDER BY path")) {
      const limitMatch = /LIMIT (\d+)/.exec(flat);
      const limit = limitMatch ? Number(limitMatch[1]) : Number(params[0] ?? 1000);
      const rows = [...fileStore.keys()].sort().slice(0, limit).map((path) => ({ path }));
      return { results: rows, success: true };
    }
    if (flat.includes("SELECT path FROM mb_files WHERE checksum_sha256 IS NULL") || flat.includes("SELECT path FROM mb_files WHERE checksum_sha256")) {
      const rows = [...fileStore.entries()].filter(([, meta]) => !meta.sha256 || !meta.uploadedAt).map(([path]) => ({ path }));
      return { results: rows.slice(0, 1000), success: true };
    }
    // Handle SELECT path with OFFSET? Not needed
    if (flat.includes("SELECT path, size, content_type, etag") && flat.includes("FROM mb_files")) {
      // Generic fallback for list
      const rows = [...fileStore.entries()].map(([path, meta]) => ({
        path, size: meta.size, content_type: meta.contentType, etag: meta.etag,
        checksum_sha256: meta.sha256 ?? null,
        uploaded_at: meta.uploadedAt ?? null,
        entity_type: meta.entityType ?? null,
        entity_id: meta.entityId ?? null,
        created_at: NOW, updated_at: NOW,
      }));
      return { results: rows, success: true };
    }
    if (flat.includes("INSERT INTO mb_files")) {
      // Support legacy 4-col, v7 10-col, and fallback 8-col (older harness)
      if (params.length === 4) {
        const [path, size, contentType, etag] = params as [string, number, string, string];
        fileStore.set(path, { size, contentType, etag });
        return { results: [], success: true };
      }
      if (params.length === 10) {
        const [path, size, contentType, etag, createdAt, updatedAt, sha256v, uploadedAt, entityType, entityId] = params as [string, number, string, string, string, string, string, string, string | null, string | null];
        void createdAt; void updatedAt;
        fileStore.set(path, { size, contentType, etag, sha256: sha256v, uploadedAt, entityType, entityId });
        return { results: [], success: true };
      }
      if (params.length >= 8) {
        const [path, size, contentType, etag, sha256v, uploadedAt, entityType, entityId] = params as [string, number, string, string, string, string, string | null, string | null];
        fileStore.set(path, { size, contentType, etag, sha256: sha256v, uploadedAt, entityType, entityId });
        return { results: [], success: true };
      }
      // Fallback: generic
      const [path, size, contentType, etag] = params as [string, number, string, string];
      fileStore.set(String(path), { size: Number(size), contentType: String(contentType), etag: String(etag) });
      return { results: [], success: true };
    }
    // Artifact SELECTs
    if (flat.includes("FROM mb_artifacts WHERE artifact_id = ?")) {
      const artifactId = String(params[0]);
      const meta = artifactStore.get(artifactId);
      if (!meta) return { results: [], success: true };
      return {
        results: [{
          artifact_id: meta.artifactId, storage_key: meta.storageKey, size: meta.size, content_type: meta.contentType, etag: meta.etag,
          checksum_sha256: meta.sha256, uploaded_at: meta.uploadedAt, entity_type: meta.entityType, entity_id: meta.entityId, created_at: meta.createdAt,
        }],
        success: true,
      };
    }
    // Probe SELECT artifact_id FROM mb_artifacts LIMIT 1
    if (flat.includes("SELECT artifact_id FROM mb_artifacts LIMIT 1")) {
      const first = [...artifactStore.values()][0];
      return { results: first ? [{ artifact_id: first.artifactId }] : [], success: true };
    }
    // List artifacts ordering
    if (flat.includes("FROM mb_artifacts ORDER BY artifact_id") || flat.includes("FROM mb_artifacts WHERE")) {
      // Handle reconciliation selects: SELECT artifact_id, storage_key, size, etag, checksum_sha256, uploaded_at, entity_type, entity_id FROM mb_artifacts ORDER BY artifact_id LIMIT 1000
      // Also generic
      if (flat.includes("ORDER BY artifact_id")) {
        const limitMatch = /LIMIT (\d+)/.exec(flat);
        const limit = limitMatch ? Number(limitMatch[1]) : 1000;
        const rows = [...artifactStore.values()].sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1)).slice(0, limit).map((meta) => ({
          artifact_id: meta.artifactId, storage_key: meta.storageKey, size: meta.size, content_type: meta.contentType, etag: meta.etag,
          checksum_sha256: meta.sha256, uploaded_at: meta.uploadedAt, entity_type: meta.entityType, entity_id: meta.entityId, created_at: meta.createdAt,
        }));
        return { results: rows, success: true };
      }
      // Simple SELECT artifact_id or count?
      const rows = [...artifactStore.values()].map((meta) => ({
        artifact_id: meta.artifactId, storage_key: meta.storageKey, size: meta.size, content_type: meta.contentType, etag: meta.etag,
        checksum_sha256: meta.sha256, uploaded_at: meta.uploadedAt, entity_type: meta.entityType, entity_id: meta.entityId, created_at: meta.createdAt,
      }));
      return { results: rows, success: true };
    }
    // Insert artifacts: INSERT INTO mb_artifacts (artifact_id, storage_key, size, content_type, etag, checksum_sha256, uploaded_at, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    if (flat.includes("INSERT INTO mb_artifacts")) {
      const [artifactId, storageKey, size, contentType, etag, sha256v, uploadedAt, entityType, entityId, createdAt] = params as [string, string, number, string | null, string, string, string, string | null, string | null, string];
      if (artifactStore.has(artifactId)) {
        throw Object.assign(new Error("UNIQUE constraint failed: mb_artifacts.artifact_id"), { code: "SQLITE_CONSTRAINT" });
      }
      // storage_key UNIQUE
      for (const existing of artifactStore.values()) {
        if (existing.storageKey === storageKey) {
          throw Object.assign(new Error("UNIQUE constraint failed: mb_artifacts.storage_key"), { code: "SQLITE_CONSTRAINT" });
        }
      }
      artifactStore.set(artifactId, {
        artifactId, storageKey, size, contentType, etag, sha256: sha256v, uploadedAt, entityType, entityId, createdAt,
      });
      return { results: [], success: true };
    }
    throw new Error(`harness: unmodelled project SQL: ${flat}`);
  }

  /**
   * Rate-limit bindings, declared the way a real deployment declares them.
   *
   * `omitRateLimiters` models a Worker with no binding at all, which is how the
   * fail-closed `MB_RATE_LIMITER_REQUIRED` path is exercised. `perRouteRateLimiters`
   * models the CP-03 shape: three namespaces, each able to carry its own limit and
   * period, so a browser polling `/v1/data` cannot consume the control plane's
   * allowance.
   */
  const deniedRoutes = new Set(options.rateLimitDeniedRoutes ?? []);
  const deniedProjects = new Set(options.rateLimitDeniedProjects ?? []);
  function limiter(binding: HarnessRateLimitCall["binding"]) {
    return {
      async limit({ key }: { key: string }) {
        rateLimitCalls.push({ binding, key });
        const [route, dimension, ...rest] = key.split(":");
        // A project bucket is denied per project; every other dimension per route.
        if (dimension === "project") return { success: !deniedProjects.has(rest.join(":")) };
        if (deniedRoutes.has(route as RouteClass)) return { success: false };
        return { success: options.rateLimitSuccess ?? true };
      },
    };
  }
  const rateLimiters = options.omitRateLimiters
    ? {}
    : options.perRouteRateLimiters
      ? {
        RATE_LIMITER_CONTROL: limiter("RATE_LIMITER_CONTROL"),
        RATE_LIMITER_DATA: limiter("RATE_LIMITER_DATA"),
        RATE_LIMITER_FILES: limiter("RATE_LIMITER_FILES"),
      }
      : { RATE_LIMITER: limiter("RATE_LIMITER") };

  const env: MiniBaseEnv = {
    CONTROL_DB: {
      prepare: statement,
      /**
       * Deliberately inert apart from the quota update.
       *
       * Executing every batched statement would start recording audit rows for
       * control-plane mutations the harness previously dropped, which would
       * change assertions across provisioning, key, and origin tests that have
       * nothing to do with CP-03. Only the transition CP-03 tests must observe —
       * a replaced project quota — is modelled.
       */
      async batch(statements: Array<{ sql: string; boundValues: () => unknown[] }>) {
        for (const prepared of statements) {
          if (prepared.sql.includes("UPDATE projects") && prepared.sql.includes("quota_max_json_bytes")) {
            applyQuotaUpdate(prepared.boundValues());
          }
        }
        return [];
      },
    } as unknown as MiniBaseEnv["CONTROL_DB"],
    CLOUDFLARE_ACCOUNT_ID: "harness-account",
    CLOUDFLARE_D1_API_TOKEN: "harness-token-never-returned",
    ...(options.limits ?? {}),
    ...(options.rateLimiterRequired ? { MB_RATE_LIMITER_REQUIRED: "true" } : {}),
    ...rateLimiters,
    FILES: {
      async get(key: string, _options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
        const body = r2Bodies.get(key);
        if (body === undefined) return null;
        const meta = r2Meta.get(key);
        const object = r2Object(key, body, meta);
        void _options;
        return { ...object, body: new Response(body).body ?? undefined } as unknown as R2Object;
      },
      async head(key: string) {
        const body = r2Bodies.get(key);
        if (body === undefined) return null;
        const meta = r2Meta.get(key);
        return r2Object(key, body, meta);
      },
      async put(key: string, value: ReadableStream | string | ArrayBuffer | ArrayBufferView | Blob | null, options?: import("./contracts").R2PutOptions & { onlyIf?: import("./contracts").R2Conditional }) {
        // Atomic conditional check: reserve key synchronously before async body read
        const isConditional = options?.onlyIf?.etagDoesNotMatch === "*";
        if (isConditional && r2Bodies.has(key)) {
          return null as unknown as R2Object;
        }
        if (isConditional) {
          // Reserve to block concurrent conditional puts
          r2Bodies.set(key, "__pending__");
          r2Meta.set(key, { size: 0, etag: "__pending__", uploaded: new Date() });
        }
        let body: string;
        try {
          if (typeof value === "string") body = value;
          else if (value instanceof ReadableStream) body = await new Response(value).text();
          else if (value instanceof ArrayBuffer) body = new TextDecoder().decode(value);
          else if (ArrayBuffer.isView(value)) body = new TextDecoder().decode(value as ArrayBufferView);
          else if (value === null) body = "";
          else if (value instanceof Blob) body = await (value as Blob).text();
          else body = await new Response(value as unknown as ReadableStream).text();
        } catch {
          if (isConditional) {
            r2Bodies.delete(key);
            r2Meta.delete(key);
          }
          throw new Error("r2_read_failed");
        }
        // If another conditional put raced and we reserved, the first to complete wins; second's reservation already checked above
        // But if we reserved, ensure we don't have a pending marker from a failed concurrent that we just deleted? For single-threaded test, this is fine.
        const size = new TextEncoder().encode(body).byteLength;
        const etag = `etag-${key.length}-${size}-${body.slice(0, 8)}`;
        r2Bodies.set(key, body);
        const ct = options?.httpMetadata instanceof Headers ? options.httpMetadata.get("content-type") ?? undefined : (options?.httpMetadata as { contentType?: string } | undefined)?.contentType;
        r2Meta.set(key, { size, etag, uploaded: new Date(), contentType: ct });
        if (!r2Keys.includes(key)) r2Keys.push(key);
        else {
          // Ensure r2Keys doesn't duplicate for concurrent second attempt that was blocked? But second was returned null earlier, so not here
        }
        return r2Object(key, body, { size, etag });
      },
      async delete(key: string | string[]) {
        for (const value of Array.isArray(key) ? key : [key]) {
          r2Bodies.delete(value);
          r2Meta.delete(value);
        }
      },
      async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
        const prefix = options?.prefix ?? "";
        const limit = options?.limit ?? 1000;
        const allKeys = [...r2Bodies.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = options?.cursor ? allKeys.findIndex((k) => k > options.cursor!) : 0;
        const slice = allKeys.slice(start >= 0 ? start : 0, (start >= 0 ? start : 0) + limit);
        const objects = slice.map((key) => {
          const body = r2Bodies.get(key)!;
          const meta = r2Meta.get(key);
          return r2Object(key, body, meta);
        });
        const truncated = allKeys.length > (start >= 0 ? start : 0) + limit;
        return { objects, truncated, cursor: truncated ? slice.at(-1) : undefined, delimitedPrefixes: [] } as unknown as ReturnType<MiniBaseEnv["FILES"]["list"]>;
      },
    } as unknown as MiniBaseEnv["FILES"],
  };

  const originalFetch = globalThis.fetch;
  let projectD1FailuresRemaining = options.failProjectD1Requests ?? 0;
  let artifactInsertFailuresRemaining = options.failArtifactInsertRequests ?? 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = D1_QUERY.exec(url);
    if (!match) return originalFetch(input as string, init);
    const payload = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params: unknown[] };
    // `d1Calls` counts actual outbound REST attempts, including failures before
    // SQLite sees a statement. This is the metric command tests use for the
    // one-round-trip contract.
    d1Calls.push({ databaseId: match[2], sql: payload.sql, params: payload.params ?? [] });
    const isArtifactInsert = payload.sql.includes("INSERT INTO mb_artifacts");
    if (isArtifactInsert && artifactInsertFailuresRemaining > 0) {
      artifactInsertFailuresRemaining -= 1;
      return Response.json({ success: false, errors: [{ message: "transport failed" }] }, { status: 503 });
    }
    if (projectD1FailuresRemaining > 0) {
      projectD1FailuresRemaining -= 1;
      return Response.json({ success: false, errors: [{ message: "transport failed" }] }, { status: 503 });
    }
    try {
      const result = executeProjectSql(match[2], payload.sql, payload.params ?? []);
      if (!result) {
        return Response.json({ success: false, errors: [{ message: "unknown database" }] }, { status: 404 });
      }
      return Response.json({ success: true, result: [result] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Simulate D1 error shape for SQLite constraint/column/table errors so callers can
      // branch on message content (e.g., "no such column", "UNIQUE constraint failed").
      const status = message.includes("UNIQUE constraint failed") ? 400 : 400;
      // The client code interprets thrown errors containing those substrings, regardless of status.
      // To make queryProjectD1 throw with that message, we return success false.
      return Response.json({ success: false, errors: [{ message }] }, { status });
    }
  }) as typeof fetch;

  async function request(path: string, init: RequestInit = {}) {
    const worker = (await import("./index")).default as unknown as {
      fetch(request: Request, env: MiniBaseEnv, context: unknown): Promise<Response>;
    };
    return worker.fetch(
      new Request(`https://minibase.test${path}`, init),
      env,
      { waitUntil() {}, passThroughOnException() {} },
    );
  }

  return {
    env,
    audit,
    records,
    commands,
    commandMutations,
    files,
    schemaStore,
    projectRows,
    r2Keys,
    d1Calls,
    controlSql,
    rateLimitCalls,
    artifacts,
    request,
    dispose() {
      globalThis.fetch = originalFetch;
    },
  };
}

/** Addresses every distinct project database a run touched. */
export function addressedDatabases(harness: Harness): string[] {
  return [...new Set(harness.d1Calls.map((call) => call.databaseId))];
}

/** R2 keys MiniBase addressed, which is the whole of file isolation. */
export function addressedObjects(harness: Harness): string[] {
  return [...harness.r2Keys];
}
