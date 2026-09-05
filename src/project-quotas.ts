import type { ManagementPrincipal, MiniBaseEnv } from "./contracts";
import { HARD_LIMITS, resolveLimits, type MiniBaseLimits } from "./limits";

/**
 * CP-03 per-project quotas.
 *
 * A quota is a **tighten-only** override of the deployment ceiling that CP-01's
 * `src/limits.ts` already resolves from Worker `vars`. The relationship is strict
 * and one-directional:
 *
 * ```text
 * HARD_LIMITS[key]  >=  deployment ceiling  >=  project quota  =  enforced value
 * ```
 *
 * So a project can be given a smaller allowance than the deployment, and can
 * never be given a larger one — not through the management endpoint, and not by
 * editing `projects.quota_*` directly in the control D1. That single rule is what
 * makes per-project quotas safe on a platform whose D1 and R2 capacity is shared
 * by every tenant.
 *
 * The quota row rides along on the `api_keys JOIN projects` query that data-plane
 * authentication already runs, so CP-03 adds **zero** control-D1 statements to the
 * request hot path. That is why these are columns on `projects` and not a separate
 * table; see `migrations/0008_project_quotas.sql`.
 */

/** The deployment ceilings a project may tighten. */
export type QuotaKey = "maxJsonBytes" | "maxFileBytes" | "maxPageSize" | "maxBulkRecords";

export const QUOTA_KEYS: readonly QuotaKey[] = [
  "maxJsonBytes",
  "maxFileBytes",
  "maxPageSize",
  "maxBulkRecords",
];

/** Control-D1 column holding each quota, added by `migrations/0008_project_quotas.sql`. */
export const QUOTA_COLUMNS = {
  maxJsonBytes: "quota_max_json_bytes",
  maxFileBytes: "quota_max_file_bytes",
  maxPageSize: "quota_max_page_size",
  maxBulkRecords: "quota_max_bulk_records",
} as const;

/**
 * The stored quota row. `null` means "inherit the deployment ceiling", which is
 * what every project provisioned before CP-03 holds.
 */
export interface ProjectQuotaRow {
  quota_max_json_bytes: number | null;
  quota_max_file_bytes: number | null;
  quota_max_page_size: number | null;
  quota_max_bulk_records: number | null;
}

const EMPTY_QUOTA_ROW: ProjectQuotaRow = {
  quota_max_json_bytes: null,
  quota_max_file_bytes: null,
  quota_max_page_size: null,
  quota_max_bulk_records: null,
};

/**
 * Resolves one stored quota against the deployment ceiling.
 *
 * Fail-closed on anything unexpected: the stored value is used only when it is a
 * positive integer at or below both the deployment ceiling and the absolute hard
 * maximum. `null`, `undefined`, zero, negative, fractional, oversized, and
 * non-numeric values all fall back to the deployment ceiling. This is CP-01's
 * `resolveLimit` rule applied one level down — an invalid quota narrows nothing
 * and widens nothing, it is simply ignored.
 *
 * Exported because the clamp is the security property and is tested directly.
 */
export function resolveProjectQuota(key: QuotaKey, stored: unknown, deployment: MiniBaseLimits): number {
  const ceiling = Math.min(deployment[key], HARD_LIMITS[key]);
  if (typeof stored !== "number" || !Number.isInteger(stored)) return ceiling;
  if (stored < 1 || stored > ceiling) return ceiling;
  return stored;
}

/**
 * Effective ceilings for one project: the deployment limits, tightened by that
 * project's quota row.
 *
 * `keyActivityIntervalMs` is inherited unchanged on purpose. It sizes the
 * control-D1 write budget shared by every tenant, so a project that could raise
 * it would raise the whole deployment's write volume — the exact coupling CP-01
 * removed. It is not a tenant quota and never becomes one.
 */
export function resolveProjectLimits(
  deployment: MiniBaseLimits,
  row: ProjectQuotaRow | null | undefined,
): MiniBaseLimits {
  const quotas = row ?? EMPTY_QUOTA_ROW;
  const maxPageSize = resolveProjectQuota("maxPageSize", quotas.quota_max_page_size, deployment);
  return {
    maxJsonBytes: resolveProjectQuota("maxJsonBytes", quotas.quota_max_json_bytes, deployment),
    maxFileBytes: resolveProjectQuota("maxFileBytes", quotas.quota_max_file_bytes, deployment),
    maxPageSize,
    maxBulkRecords: resolveProjectQuota("maxBulkRecords", quotas.quota_max_bulk_records, deployment),
    keyActivityIntervalMs: deployment.keyActivityIntervalMs,
    // A page default can never exceed the page maximum it belongs to.
    defaultPageSize: Math.min(deployment.defaultPageSize, maxPageSize),
  };
}

/** A quota replacement body: an explicit `null` clears that quota. */
export type ProjectQuotaInput = Record<QuotaKey, number | null>;

const EMPTY_QUOTA_INPUT: ProjectQuotaInput = {
  maxJsonBytes: null,
  maxFileBytes: null,
  maxPageSize: null,
  maxBulkRecords: null,
};

/**
 * Parses and validates a quota replacement body.
 *
 * Unknown fields are rejected rather than ignored, so a misspelled quota cannot
 * look like it was applied. Values are validated against the absolute hard
 * maximum, not against today's deployment ceiling: deployment `vars` are an
 * operator decision that can change between requests, and the runtime clamp in
 * `resolveProjectQuota` is what actually guarantees tighten-only. Rejecting a
 * value merely because the current deployment happens to be stricter would make
 * the stored quota silently depend on configuration.
 */
export function parseProjectQuotas(value: unknown): ProjectQuotaInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body_must_be_object");
  const candidate = value as Record<string, unknown>;
  const known = QUOTA_KEYS as readonly string[];
  for (const field of Object.keys(candidate)) {
    if (!known.includes(field)) throw new Error("invalid_quota");
  }
  const quotas = { ...EMPTY_QUOTA_INPUT };
  for (const key of QUOTA_KEYS) {
    const raw = candidate[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > HARD_LIMITS[key]) {
      throw new Error("invalid_quota");
    }
    quotas[key] = raw;
  }
  return quotas;
}

/** What a consumer needs in order to stay inside its own project's ceiling. */
export interface ProjectQuotaView {
  projectId: string;
  /** Stored quota per ceiling. `null` means the project inherits the deployment value. */
  configured: Record<QuotaKey, number | null>;
  /**
   * What the Worker will actually enforce, after the tighten-only clamp. This can
   * be lower than `configured` when a stored quota exceeds the deployment ceiling.
   * `keyActivityIntervalMs` is absent because it is not a tenant quota.
   */
  effective: Omit<MiniBaseLimits, "keyActivityIntervalMs">;
}

function quotaView(
  projectId: string,
  row: ProjectQuotaRow,
  deployment: MiniBaseLimits,
): ProjectQuotaView {
  const resolved = resolveProjectLimits(deployment, row);
  return {
    projectId,
    configured: {
      maxJsonBytes: row.quota_max_json_bytes,
      maxFileBytes: row.quota_max_file_bytes,
      maxPageSize: row.quota_max_page_size,
      maxBulkRecords: row.quota_max_bulk_records,
    },
    effective: {
      maxJsonBytes: resolved.maxJsonBytes,
      maxFileBytes: resolved.maxFileBytes,
      defaultPageSize: resolved.defaultPageSize,
      maxPageSize: resolved.maxPageSize,
      maxBulkRecords: resolved.maxBulkRecords,
    },
  };
}

const QUOTA_SELECT = `SELECT id, quota_max_json_bytes, quota_max_file_bytes,
       quota_max_page_size, quota_max_bulk_records
  FROM projects WHERE id = ? AND status = 'active'`;

/**
 * Reads an active project's quota row.
 *
 * Restricted to `status = 'active'` exactly like every other project-scoped
 * control-plane route (`data-keys`, `project-schema`, `file-reconciliation`), so
 * quotas of a suspended or failed project cannot be administered while it is not
 * being served. A missing project is `project_not_found`, never a partial view.
 */
async function activeProjectQuotaRow(
  env: MiniBaseEnv,
  projectId: string,
): Promise<ProjectQuotaRow | null> {
  const row = await env.CONTROL_DB.prepare(QUOTA_SELECT)
    .bind(projectId)
    .first<ProjectQuotaRow & { id: string }>();
  if (!row) return null;
  return {
    quota_max_json_bytes: row.quota_max_json_bytes ?? null,
    quota_max_file_bytes: row.quota_max_file_bytes ?? null,
    quota_max_page_size: row.quota_max_page_size ?? null,
    quota_max_bulk_records: row.quota_max_bulk_records ?? null,
  };
}

/** Reads the stored and effective quotas of one project. */
export async function readProjectQuotas(
  env: MiniBaseEnv,
  projectId: string,
  deployment: MiniBaseLimits = resolveLimits(env),
): Promise<ProjectQuotaView> {
  const row = await activeProjectQuotaRow(env, projectId);
  if (!row) throw new Error("project_not_found");
  return quotaView(projectId, row, deployment);
}

/**
 * Replaces a project's whole quota set, atomically with its audit event.
 *
 * `PUT` is a full replacement, matching `PUT /v1/projects/{id}/origins`: a field
 * that is absent or explicitly `null` is stored as `NULL` and the project
 * inherits the deployment ceiling again. Replaying an identical body therefore
 * produces an identical row, so the endpoint is idempotent.
 *
 * The update and the audit insert go through `CONTROL_DB.batch()`, which is
 * atomic, so a quota change is never visible without its audit trail.
 */
export async function replaceProjectQuotas(
  env: MiniBaseEnv,
  projectId: string,
  input: ProjectQuotaInput,
  actor: ManagementPrincipal,
  correlationId?: string,
  deployment: MiniBaseLimits = resolveLimits(env),
): Promise<ProjectQuotaView> {
  const existing = await activeProjectQuotaRow(env, projectId);
  if (!existing) throw new Error("project_not_found");
  const now = new Date().toISOString();
  const row: ProjectQuotaRow = {
    quota_max_json_bytes: input.maxJsonBytes,
    quota_max_file_bytes: input.maxFileBytes,
    quota_max_page_size: input.maxPageSize,
    quota_max_bulk_records: input.maxBulkRecords,
  };
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE projects
          SET quota_max_json_bytes = ?, quota_max_file_bytes = ?,
              quota_max_page_size = ?, quota_max_bulk_records = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(
      row.quota_max_json_bytes,
      row.quota_max_file_bytes,
      row.quota_max_page_size,
      row.quota_max_bulk_records,
      now,
      projectId,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, project_id, action, created_at, actor_key_id, outcome, metadata,
         entity, entity_id, correlation_id)
       VALUES (?, ?, 'project.quotas_replaced', ?, ?, 'success', ?, 'project', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      projectId,
      now,
      actor.keyId,
      // Quota integers only: no key material, no record payload, no caller data.
      JSON.stringify(input),
      projectId,
      correlationId ?? null,
    ),
  ]);
  return quotaView(projectId, row, deployment);
}
