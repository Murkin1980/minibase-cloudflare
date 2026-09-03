import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { recordAudit } from "./audit";
import { DEFAULT_LIMITS, type MiniBaseLimits } from "./limits";
import { sha256 } from "./security";

interface DataKeyRow {
  id: string;
  project_id: string;
  kind: "publishable" | "secret";
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
  d1_database_id: string;
  status: string;
  last_used_at: string | null;
}

/**
 * Whether recording key activity now is worth a control-D1 write.
 *
 * `last_used_at` is key-hygiene metadata for rotation decisions, not an access
 * control: revocation and expiry are re-checked from the row on every request
 * regardless. Writing it on every request made one control-plane write row the
 * cost of every data-plane call, for every project.
 */
export function keyActivityUpdateIsDue(
  lastUsedAt: string | null | undefined,
  now: Date,
  intervalMs: number,
): boolean {
  if (!lastUsedAt) return true;
  const previous = Date.parse(lastUsedAt);
  if (!Number.isFinite(previous)) return true;
  return now.getTime() - previous >= intervalMs;
}

const scopesAllow = (row: DataKeyRow, requiredScope: string): boolean => {
  const scopes = row.scopes.split(",").map((scope) => scope.trim());
  return scopes.includes(requiredScope) || scopes.includes("project:admin");
};

export function dataKeyDenialReason(
  row: DataKeyRow | null,
  requiredScope: string,
  now: Date,
): string | null {
  if (!row) return "unknown_key";
  if (row.revoked_at) return "revoked";
  const expiry = row.expires_at ? Date.parse(row.expires_at) : null;
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now.getTime())) return "expired";
  if (row.status !== "active") return "project_inactive";
  if (!row.d1_database_id) return "project_unavailable";
  if (!scopesAllow(row, requiredScope)) return "scope";
  return null;
}

export function dataKeyRecordIsAuthorized(
  row: DataKeyRow | null,
  requiredScope: string,
  now: Date,
): boolean {
  return dataKeyDenialReason(row, requiredScope, now) === null;
}

export async function authenticateDataKey(
  env: MiniBaseEnv,
  request: Request,
  requiredScope: string,
  correlationId?: string,
  limits: MiniBaseLimits = DEFAULT_LIMITS,
): Promise<DataPrincipal | null> {
  const audit = (
    action: string,
    outcome: "denied",
    actorKeyId: string | null,
    projectId: string | null,
    metadata: Record<string, string>,
  ) => recordAudit(env, action, outcome, actorKeyId, projectId, metadata, {
    entity: "data_key",
    ...(actorKeyId ? { entityId: actorKeyId } : {}),
    ...(correlationId ? { correlationId } : {}),
  });
  const authorization = request.headers.get("authorization");
  if (
    !authorization?.startsWith("Bearer mb_publishable_") &&
    !authorization?.startsWith("Bearer mb_secret_")
  ) {
    await audit("data.auth", "denied", null, null, {
      reason: "missing_key",
      requiredScope,
    });
    return null;
  }
  const token = authorization.slice(7);
  const row = await env.CONTROL_DB.prepare(
    `SELECT k.id, k.project_id, k.kind, k.scopes, k.expires_at, k.revoked_at,
            k.last_used_at, p.d1_database_id, p.status
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
      WHERE k.key_hash = ?`,
  ).bind(await sha256(token)).first<DataKeyRow>();
  const now = new Date();
  const denialReason = dataKeyDenialReason(row, requiredScope, now);
  if (denialReason) {
    await audit("data.auth", "denied", row?.id ?? null, row?.project_id ?? null, {
      reason: denialReason,
      requiredScope,
    });
    return null;
  }
  if (!row) return null;
  if (keyActivityUpdateIsDue(row.last_used_at, now, limits.keyActivityIntervalMs)) {
    await env.CONTROL_DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .bind(now.toISOString(), row.id).run();
  }
  return {
    keyId: row.id,
    projectId: row.project_id,
    databaseId: row.d1_database_id,
    kind: row.kind,
    scopes: row.scopes.split(","),
  };
}
