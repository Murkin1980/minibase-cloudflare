import type { MiniBaseEnv } from "./contracts";
import { DEFAULT_LIMITS, type MiniBaseLimits } from "./limits";

/**
 * Audit event contract (docs/DATA_MODEL.md).
 *
 * Append-only: nothing in MiniBase updates or deletes an `audit_events` row.
 * `entity` / `entityId` name the affected resource so an operator can answer
 * "what happened to this project/key" without scanning metadata blobs, and
 * `correlationId` joins an event to the `x-minibase-request-id` a caller
 * already receives, so a support request can be traced end to end.
 *
 * Deliberately not stored: raw bearer tokens, key hashes, and record payloads.
 */
export interface AuditContext {
  entity?: "project" | "data_key" | "management_key" | "file" | "origin";
  entityId?: string;
  correlationId?: string;
}

export async function recordAudit(
  env: MiniBaseEnv,
  action: string,
  outcome: "success" | "denied" | "failed",
  actorKeyId: string | null,
  projectId: string | null = null,
  metadata?: Record<string, string>,
  context: AuditContext = {},
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO audit_events
      (id, project_id, action, created_at, actor_key_id, outcome, metadata,
       entity, entity_id, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    projectId,
    action,
    new Date().toISOString(),
    actorKeyId,
    outcome,
    metadata ? JSON.stringify(metadata) : null,
    context.entity ?? null,
    context.entityId ?? null,
    context.correlationId ?? null,
  ).run();
}

export interface AuditQuery {
  limit: number;
  before?: string;
}

export function parseAuditQuery(url: URL, limits: MiniBaseLimits = DEFAULT_LIMITS): AuditQuery {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? limits.defaultPageSize : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxPageSize) throw new Error("invalid_limit");
  const before = url.searchParams.get("before");
  if (before && !Number.isFinite(Date.parse(before))) throw new Error("invalid_before");
  return { limit, ...(before ? { before } : {}) };
}

interface AuditRow {
  id: string;
  project_id: string | null;
  action: string;
  created_at: string;
  actor_key_id: string | null;
  outcome: string;
  metadata: string | null;
  entity: string | null;
  entity_id: string | null;
  correlation_id: string | null;
}

export async function listAuditEvents(env: MiniBaseEnv, query: AuditQuery) {
  const condition = query.before ? "WHERE created_at < ?" : "";
  const statement = env.CONTROL_DB.prepare(
    `SELECT id, project_id, action, created_at, actor_key_id, outcome, metadata,
            entity, entity_id, correlation_id
       FROM audit_events
       ${condition}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  );
  const result = query.before
    ? await statement.bind(query.before, query.limit).all<AuditRow>()
    : await statement.bind(query.limit).all<AuditRow>();
  const events = (result.results ?? []).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    action: row.action,
    createdAt: row.created_at,
    actorKeyId: row.actor_key_id,
    outcome: row.outcome,
    metadata: row.metadata ? JSON.parse(row.metadata) as unknown : null,
    entity: row.entity,
    entityId: row.entity_id,
    correlationId: row.correlation_id,
  }));
  return {
    events,
    nextBefore: events.length === query.limit ? events.at(-1)?.createdAt ?? null : null,
  };
}
