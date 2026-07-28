import type { CreateDataKeyRequest, ManagementPrincipal, MiniBaseEnv } from "./contracts";
import { randomToken, sha256 } from "./security";

export async function createDataKey(
  env: MiniBaseEnv,
  projectId: string,
  input: CreateDataKeyRequest,
  actor: ManagementPrincipal,
) {
  const project = await env.CONTROL_DB.prepare(
    "SELECT id FROM projects WHERE id = ? AND status = 'active'",
  ).bind(projectId).first<{ id: string }>();
  if (!project) throw new Error("project_not_found");
  if (input.rotateFromKeyId) {
    const source = await env.CONTROL_DB.prepare(
      "SELECT id FROM api_keys WHERE id = ? AND project_id = ? AND kind = ? AND revoked_at IS NULL",
    ).bind(input.rotateFromKeyId, projectId, input.kind).first<{ id: string }>();
    if (!source) throw new Error("data_key_not_found");
  }
  const id = crypto.randomUUID();
  const key = randomToken(input.kind === "publishable" ? "mb_publishable_" : "mb_secret_");
  const now = new Date().toISOString();
  const statements = [
    env.CONTROL_DB.prepare(
      `INSERT INTO api_keys
        (id, project_id, kind, key_hash, scopes, expires_at, created_at, name, rotated_from_key_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, projectId, input.kind, await sha256(key), input.scopes.join(","),
      input.expiresAt ?? null, now, input.name, input.rotateFromKeyId ?? null,
    ),
  ];
  if (input.rotateFromKeyId) {
    statements.push(env.CONTROL_DB.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL",
    ).bind(now, input.rotateFromKeyId, projectId));
  }
  statements.push(env.CONTROL_DB.prepare(
    `INSERT INTO audit_events
      (id, project_id, action, created_at, actor_key_id, outcome, metadata)
     VALUES (?, ?, 'data_key.created', ?, ?, 'success', ?)`,
  ).bind(crypto.randomUUID(), projectId, now, actor.keyId, JSON.stringify({
    keyId: id, kind: input.kind, rotatedFromKeyId: input.rotateFromKeyId ?? "",
  })));
  await env.CONTROL_DB.batch(statements);
  return { id, key, kind: input.kind, scopes: input.scopes, expiresAt: input.expiresAt ?? null };
}

export async function revokeDataKey(
  env: MiniBaseEnv,
  projectId: string,
  keyId: string,
  actor: ManagementPrincipal,
): Promise<void> {
  const existing = await env.CONTROL_DB.prepare(
    "SELECT id FROM api_keys WHERE id = ? AND project_id = ? AND revoked_at IS NULL",
  ).bind(keyId, projectId).first<{ id: string }>();
  if (!existing) throw new Error("data_key_not_found");
  const now = new Date().toISOString();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ?",
    ).bind(now, keyId, projectId),
    env.CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, project_id, action, created_at, actor_key_id, outcome, metadata)
       VALUES (?, ?, 'data_key.revoked', ?, ?, 'success', ?)`,
    ).bind(crypto.randomUUID(), projectId, now, actor.keyId, JSON.stringify({ keyId })),
  ]);
}

interface KeyListRow {
  id: string;
  name: string | null;
  kind: string;
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
  rotated_from_key_id: string | null;
}

export async function listDataKeys(env: MiniBaseEnv, projectId: string) {
  const result = await env.CONTROL_DB.prepare(
    `SELECT id, name, kind, scopes, expires_at, revoked_at, created_at, last_used_at, rotated_from_key_id
       FROM api_keys WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`,
  ).bind(projectId).all<KeyListRow>();
  return {
    keys: (result.results ?? []).map((row) => ({
      id: row.id, name: row.name, kind: row.kind, scopes: row.scopes.split(","),
      expiresAt: row.expires_at, revokedAt: row.revoked_at, createdAt: row.created_at,
      lastUsedAt: row.last_used_at, rotatedFromKeyId: row.rotated_from_key_id,
    })),
  };
}
