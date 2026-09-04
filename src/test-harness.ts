import type { MiniBaseEnv, R2Object } from "./contracts";
import type { LimitOverrides } from "./limits";
import { sha256 } from "./security";

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
 * Statements that depend on a real engine are covered against real D1 by
 * `scripts/test-d1.mjs`.
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

export interface HarnessProjectRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  d1_database_id: string;
  data_schema_version: number;
  origins: string[];
}

export interface HarnessSchemaState {
  hasTable: boolean;
  versions: number[];
}

export interface Harness {
  env: MiniBaseEnv;
  audit: AuditRow[];
  /** database id -> collection -> record id -> row */
  records: Map<string, Map<string, Map<string, RecordRow>>>;
  /** database id -> path -> metadata */
  files: Map<string, Map<string, FileMeta>>;
  /** database id -> schema state */
  schemaStore: Map<string, HarnessSchemaState>;
  /** project id -> project row */
  projectRows: Map<string, HarnessProjectRow>;
  r2Keys: string[];
  d1Calls: D1Call[];
  controlSql: string[];
  request(path: string, init?: RequestInit): Promise<Response>;
  dispose(): void;
}

const D1_QUERY = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/query$/;

const NOW = "2026-09-03T00:00:00Z";

export function createHarness(options: HarnessOptions = {}): Harness {
  const projects = options.projects ?? [];
  const records = new Map<string, Map<string, Map<string, RecordRow>>>();
  const files = new Map<string, Map<string, FileMeta>>();
  const schemaStore = new Map<string, HarnessSchemaState>();
  const projectRows = new Map<string, HarnessProjectRow>();
  const r2Bodies = new Map<string, string>();
  const r2Keys: string[] = [];
  const audit: AuditRow[] = [];
  const d1Calls: D1Call[] = [];
  const controlSql: string[] = [];

  for (const project of projects) {
    records.set(project.databaseId, new Map());
    files.set(project.databaseId, new Map());
    projectRows.set(project.projectId, {
      id: project.projectId,
      slug: project.slug,
      name: project.name ?? project.slug,
      status: project.status ?? "active",
      d1_database_id: project.databaseId,
      data_schema_version: project.dataSchemaVersion ?? 4,
      origins: project.origins ?? [],
    });
    schemaStore.set(project.databaseId, {
      hasTable: project.hasSchemaVersionsTable !== false,
      versions: project.schemaVersions ? [...project.schemaVersions] : [1, 2, 3, 4],
    });
  }

  const dataKeyRows = new Map<string, {
    id: string; project_id: string; kind: string; scopes: string;
    expires_at: string | null; revoked_at: string | null;
    d1_database_id: string; status: string; last_used_at: string | null;
  }>();
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

  function statement(sql: string) {
    controlSql.push(sql);
    let values: unknown[] = [];
    const prepared = {
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

  function r2Object(key: string, body: string): R2Object {
    return {
      key,
      size: new TextEncoder().encode(body).byteLength,
      etag: `etag-${key.length}`,
      httpEtag: `"etag-${key.length}"`,
      uploaded: new Date(),
      writeHttpMetadata() {},
    };
  }

  function executeProjectSql(databaseId: string, sql: string, params: unknown[]) {
    const store = records.get(databaseId);
    const fileStore = files.get(databaseId);
    const schema = schemaStore.get(databaseId);
    if (!store || !fileStore) return null;
    d1Calls.push({ databaseId, sql, params });
    const flat = sql.replace(/\s+/g, " ");

    if (flat.includes("FROM sqlite_master WHERE type = 'table' AND name = 'mb_schema_versions'")) {
      return {
        results: schema?.hasTable ? [{ name: "mb_schema_versions" }] : [],
        success: true,
      };
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
    if (flat.startsWith("CREATE TABLE IF NOT EXISTS") || flat.startsWith("CREATE INDEX IF NOT EXISTS")) {
      return { results: [], success: true };
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
    if (flat.includes("FROM mb_records WHERE collection = ? AND id > ?")) {
      const [collection, after, limit] = params as [string, string, number];
      return {
        results: [...(store.get(collection) ?? new Map()).values()]
          .filter((row) => row.id > after)
          .sort((left, right) => (left.id < right.id ? -1 : 1))
          .slice(0, limit),
        success: true,
      };
    }
    if (flat.includes("FROM mb_records WHERE collection = ? AND id = ?")) {
      const [collection, id] = params as [string, string];
      const row = store.get(collection)?.get(id);
      return { results: row ? [row] : [], success: true };
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
    if (flat.includes("FROM mb_files WHERE path > ?")) {
      const [after, limit] = params as [string, number];
      return {
        results: [...fileStore.entries()]
          .filter(([path]) => path > after)
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .slice(0, limit)
          .map(([path, meta]) => ({
            path, size: meta.size, content_type: meta.contentType, etag: meta.etag,
            created_at: NOW, updated_at: NOW,
          })),
        success: true,
      };
    }
    if (flat.includes("FROM mb_files WHERE path = ?")) {
      const path = String(params[0]);
      const meta = fileStore.get(path);
      return {
        results: meta
          ? [{ path, size: meta.size, content_type: meta.contentType, etag: meta.etag, created_at: NOW, updated_at: NOW }]
          : [],
        success: true,
      };
    }
    if (flat.includes("INSERT INTO mb_files")) {
      const [path, size, contentType, etag] = params as [string, number, string, string];
      fileStore.set(path, { size, contentType, etag });
      return { results: [], success: true };
    }
    throw new Error(`harness: unmodelled project SQL: ${flat}`);
  }

  const env: MiniBaseEnv = {
    CONTROL_DB: { prepare: statement, batch: async () => [] } as unknown as MiniBaseEnv["CONTROL_DB"],
    CLOUDFLARE_ACCOUNT_ID: "harness-account",
    CLOUDFLARE_D1_API_TOKEN: "harness-token-never-returned",
    ...(options.limits ?? {}),
    RATE_LIMITER: { async limit() { return { success: options.rateLimitSuccess ?? true }; } },
    FILES: {
      async get(key: string) {
        const body = r2Bodies.get(key);
        if (body === undefined) return null;
        const object = r2Object(key, body);
        return { ...object, body: new Response(body).body ?? undefined };
      },
      async put(key: string, value: ReadableStream | string) {
        const body = typeof value === "string" ? value : await new Response(value).text();
        r2Bodies.set(key, body);
        r2Keys.push(key);
        return r2Object(key, body);
      },
      async delete(key: string | string[]) {
        for (const value of Array.isArray(key) ? key : [key]) r2Bodies.delete(value);
      },
      async list() {
        return { objects: [], truncated: false };
      },
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = D1_QUERY.exec(url);
    if (!match) return originalFetch(input as string, init);
    const payload = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params: unknown[] };
    const result = executeProjectSql(match[2], payload.sql, payload.params ?? []);
    if (!result) {
      return Response.json({ success: false, errors: [{ message: "unknown database" }] }, { status: 404 });
    }
    return Response.json({ success: true, result: [result] });
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
    files,
    schemaStore,
    projectRows,
    r2Keys,
    d1Calls,
    controlSql,
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
