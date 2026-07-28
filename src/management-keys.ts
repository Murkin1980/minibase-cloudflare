import type {
  CreateManagementKeyRequest,
  ManagementPrincipal,
  MiniBaseEnv,
} from "./contracts";
import { randomToken, sha256 } from "./security";

interface ManagementKeyRow {
  id: string;
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const parseBearer = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer mb_management_")) return null;
  return authorization.slice(7);
};

const parseScopes = (value: string): string[] =>
  value.split(",").map((scope) => scope.trim()).filter(Boolean);

export function managementKeyRecordIsAuthorized(
  row: ManagementKeyRow | null,
  requiredScope: string,
  now: Date,
): boolean {
  if (!row || row.revoked_at) return false;
  if (row.expires_at && new Date(row.expires_at) <= now) return false;
  return parseScopes(row.scopes).includes(requiredScope);
}

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

export async function authenticateManagementKey(
  env: MiniBaseEnv,
  request: Request,
  requiredScope: string,
): Promise<ManagementPrincipal | null> {
  const token = parseBearer(request);
  if (!token) {
    await recordAudit(env, "management.auth", "denied", null, null, { reason: "missing_key" });
    return null;
  }

  const row = await env.CONTROL_DB.prepare(
    `SELECT id, scopes, expires_at, revoked_at
       FROM management_keys
      WHERE key_hash = ?`,
  ).bind(await sha256(token)).first<ManagementKeyRow>();
  const now = new Date();
  const scopes = row ? parseScopes(row.scopes) : [];
  const expired = Boolean(row?.expires_at && new Date(row.expires_at) <= now);
  if (!row || !managementKeyRecordIsAuthorized(row, requiredScope, now)) {
    await recordAudit(env, "management.auth", "denied", row?.id ?? null, null, {
      reason: !row ? "unknown_key" : row.revoked_at ? "revoked" : expired ? "expired" : "scope",
      requiredScope,
    });
    return null;
  }

  await env.CONTROL_DB.prepare(
    "UPDATE management_keys SET last_used_at = ? WHERE id = ?",
  ).bind(now.toISOString(), row.id).run();
  return { keyId: row.id, scopes };
}

export async function createManagementKey(
  env: MiniBaseEnv,
  input: CreateManagementKeyRequest,
  actor: ManagementPrincipal,
): Promise<{ id: string; key: string; expiresAt: string | null }> {
  const id = crypto.randomUUID();
  const key = randomToken("mb_management_");
  const now = new Date().toISOString();
  const createStatement = env.CONTROL_DB.prepare(
    `INSERT INTO management_keys
      (id, name, key_hash, scopes, expires_at, rotated_from_key_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    input.name,
    await sha256(key),
    input.scopes.join(","),
    input.expiresAt ?? null,
    input.rotateFromKeyId ?? null,
    now,
  );
  const statements = [createStatement];
  if (input.rotateFromKeyId) {
    statements.push(env.CONTROL_DB.prepare(
      "UPDATE management_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(now, input.rotateFromKeyId));
  }
  statements.push(env.CONTROL_DB.prepare(
    `INSERT INTO audit_events
      (id, project_id, action, created_at, actor_key_id, outcome, metadata)
     VALUES (?, NULL, 'management_key.created', ?, ?, 'success', ?)`,
  ).bind(crypto.randomUUID(), now, actor.keyId, JSON.stringify({
    createdKeyId: id,
    rotatedFromKeyId: input.rotateFromKeyId ?? "",
  })));
  await env.CONTROL_DB.batch(statements);
  return { id, key, expiresAt: input.expiresAt ?? null };
}

export async function revokeManagementKey(
  env: MiniBaseEnv,
  keyId: string,
  actor: ManagementPrincipal,
): Promise<void> {
  if (keyId === actor.keyId) throw new Error("active_key_self_revoke_forbidden");
  const existing = await env.CONTROL_DB.prepare(
    "SELECT id FROM management_keys WHERE id = ? AND revoked_at IS NULL",
  ).bind(keyId).first<{ id: string }>();
  if (!existing) throw new Error("management_key_not_found");
  const now = new Date().toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
    "UPDATE management_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(now, keyId),
    env.CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, project_id, action, created_at, actor_key_id, outcome, metadata)
       VALUES (?, NULL, 'management_key.revoked', ?, ?, 'success', ?)`,
    ).bind(crypto.randomUUID(), now, actor.keyId, JSON.stringify({ revokedKeyId: keyId })),
  ]);
}
