import type { MiniBaseEnv } from "./contracts";

export async function recordAudit(
  env: MiniBaseEnv,
  action: string,
  outcome: "success" | "denied" | "failed",
  actorKeyId: string | null,
  projectId: string | null = null,
  metadata?: Record<string, string>,
): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO audit_events
      (id, project_id, action, created_at, actor_key_id, outcome, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    projectId,
    action,
    new Date().toISOString(),
    actorKeyId,
    outcome,
    metadata ? JSON.stringify(metadata) : null,
  ).run();
}

export interface AuditQuery {
  limit: number;
  before?: string;
}

export function parseAuditQuery(url: URL): AuditQuery {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
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
}

export async function listAuditEvents(env: MiniBaseEnv, query: AuditQuery) {
  const condition = query.before ? "WHERE created_at < ?" : "";
  const statement = env.CONTROL_DB.prepare(
    `SELECT id, project_id, action, created_at, actor_key_id, outcome, metadata
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
  }));
  return {
    events,
    nextBefore: events.length === query.limit ? events.at(-1)?.createdAt ?? null : null,
  };
}
