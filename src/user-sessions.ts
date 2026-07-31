import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { verifyAccessIdentity } from "./access-auth";
import { randomToken, sha256 } from "./security";

const SESSION_TTL_SECONDS = 8 * 60 * 60;

export async function createUserSession(
  env: MiniBaseEnv,
  request: Request,
  projectPrincipal: DataPrincipal,
): Promise<{ token: string; expiresAt: string }> {
  if (projectPrincipal.kind !== "publishable") throw new Error("session_exchange_forbidden");
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) throw new Error("access_identity_required");
  const subject = await verifyAccessIdentity(env, assertion);
  const token = randomToken("mb_session_");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const scopes = projectPrincipal.scopes
    .filter((scope) => scope === "data:read" || scope === "data:write")
    .join(",");
  await env.CONTROL_DB.prepare(
    `INSERT INTO user_sessions
      (id, project_id, token_hash, subject_hash, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    projectPrincipal.projectId,
    await sha256(token),
    await sha256(`${projectPrincipal.projectId}:${subject}`),
    scopes,
    now.toISOString(),
    expiresAt,
  ).run();
  return { token, expiresAt };
}

export async function revokeCurrentSession(
  env: MiniBaseEnv,
  principal: DataPrincipal,
): Promise<void> {
  if (!principal.subjectHash) throw new Error("session_required");
  await env.CONTROL_DB.prepare(
    "UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(new Date().toISOString(), principal.keyId).run();
}
