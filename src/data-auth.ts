import type { DataPrincipal, MiniBaseEnv } from "./contracts";
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
}

interface SessionRow {
  id: string;
  project_id: string;
  subject_hash: string;
  scopes: string;
  expires_at: string;
  revoked_at: string | null;
  d1_database_id: string;
  status: string;
}

export function sessionRecordIsAuthorized(
  row: SessionRow | null,
  requiredScope: string,
  now: Date,
): boolean {
  if (!row || row.status !== "active" || !row.d1_database_id || row.revoked_at) return false;
  const expiry = Date.parse(row.expires_at);
  return Number.isFinite(expiry) && expiry > now.getTime() && row.scopes.split(",").includes(requiredScope);
}

const scopesAllow = (row: DataKeyRow, requiredScope: string): boolean => {
  const scopes = row.scopes.split(",").map((scope) => scope.trim());
  return scopes.includes(requiredScope) || scopes.includes("project:admin");
};

export function dataKeyRecordIsAuthorized(
  row: DataKeyRow | null,
  requiredScope: string,
  now: Date,
): boolean {
  if (!row || row.status !== "active" || !row.d1_database_id || row.revoked_at) return false;
  const expiry = row.expires_at ? Date.parse(row.expires_at) : null;
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now.getTime())) return false;
  return scopesAllow(row, requiredScope);
}

export async function authenticateDataKey(
  env: MiniBaseEnv,
  request: Request,
  requiredScope: string,
): Promise<DataPrincipal | null> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer mb_session_")) {
    const token = authorization.slice(7);
    const row = await env.CONTROL_DB.prepare(
      `SELECT s.id, s.project_id, s.subject_hash, s.scopes, s.expires_at, s.revoked_at,
              p.d1_database_id, p.status
         FROM user_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE s.token_hash = ?`,
    ).bind(await sha256(token)).first<SessionRow>();
    const now = new Date();
    if (!sessionRecordIsAuthorized(row, requiredScope, now)) return null;
    const scopes = row!.scopes.split(",");
    await env.CONTROL_DB.prepare("UPDATE user_sessions SET last_used_at = ? WHERE id = ?")
      .bind(now.toISOString(), row!.id).run();
    return {
      keyId: row!.id,
      projectId: row!.project_id,
      databaseId: row!.d1_database_id,
      kind: "publishable",
      scopes,
      subjectHash: row!.subject_hash,
    };
  }
  if (
    !authorization?.startsWith("Bearer mb_publishable_") &&
    !authorization?.startsWith("Bearer mb_secret_")
  ) return null;
  const token = authorization.slice(7);
  const row = await env.CONTROL_DB.prepare(
    `SELECT k.id, k.project_id, k.kind, k.scopes, k.expires_at, k.revoked_at,
            p.d1_database_id, p.status
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
      WHERE k.key_hash = ?`,
  ).bind(await sha256(token)).first<DataKeyRow>();
  const now = new Date();
  if (!row || !dataKeyRecordIsAuthorized(row, requiredScope, now)) return null;
  await env.CONTROL_DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
    .bind(now.toISOString(), row.id).run();
  return {
    keyId: row.id,
    projectId: row.project_id,
    databaseId: row.d1_database_id,
    kind: row.kind,
    scopes: row.scopes.split(","),
  };
}
