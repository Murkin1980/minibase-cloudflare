import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { recordAudit } from "./audit";
import { DEFAULT_LIMITS, type MiniBaseLimits } from "./limits";
import { resolveProjectLimits, type ProjectQuotaRow } from "./project-quotas";
import { isSafeIdentity, sha256 } from "./security";

interface DataKeyRow extends ProjectQuotaRow {
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
  // CP-03 fail-closed project context.
  //
  // These two values are the whole of MiniBase's data isolation: `project_id`
  // becomes the R2 key prefix and `d1_database_id` becomes a segment of the
  // Cloudflare REST path. Neither is a bound parameter, so neither may be
  // attacker- or corruption-shaped. A missing database was already refused;
  // CP-03 also refuses one that is present but not a safe identity, and applies
  // the same rule to the project ID.
  //
  // The refusal reuses the existing `project_unavailable` reason, so it is
  // audited like every other denial and returns the same 401 as an unknown key:
  // a caller cannot distinguish a malformed control row from a project that does
  // not exist, and no request reaches Cloudflare or R2.
  if (!isSafeIdentity(row.project_id) || !isSafeIdentity(row.d1_database_id)) {
    return "project_unavailable";
  }
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
    // CP-03: the quota columns ride along on the join that already resolves the
    // database UUID, so per-project quotas add no statement to the hot path.
    `SELECT k.id, k.project_id, k.kind, k.scopes, k.expires_at, k.revoked_at,
            k.last_used_at, p.d1_database_id, p.status,
            p.quota_max_json_bytes, p.quota_max_file_bytes,
            p.quota_max_page_size, p.quota_max_bulk_records
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
    // Deployment ceilings tightened by this project's quota row. Invalid or
    // oversized stored quotas fall back to the deployment value, never widen it.
    limits: resolveProjectLimits(limits, row),
  };
}
