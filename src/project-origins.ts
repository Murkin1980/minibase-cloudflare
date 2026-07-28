import type { ManagementPrincipal, MiniBaseEnv } from "./contracts";
import { normalizeOrigin } from "./cors";

export function parseOrigins(value: unknown): string[] {
  if (!value || typeof value !== "object") throw new Error("body_must_be_object");
  const origins = (value as Record<string, unknown>).origins;
  if (!Array.isArray(origins) || origins.length > 20 || origins.some((origin) => typeof origin !== "string")) {
    throw new Error("invalid_origins");
  }
  return [...new Set((origins as string[]).map(normalizeOrigin))];
}

export async function replaceProjectOrigins(
  env: MiniBaseEnv,
  projectId: string,
  origins: string[],
  actor: ManagementPrincipal,
): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    env.CONTROL_DB.prepare("DELETE FROM project_origins WHERE project_id = ?").bind(projectId),
    ...origins.map((origin) => env.CONTROL_DB.prepare(
      "INSERT INTO project_origins (project_id, origin, created_at) VALUES (?, ?, ?)",
    ).bind(projectId, origin, now)),
    env.CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, project_id, action, created_at, actor_key_id, outcome, metadata)
       VALUES (?, ?, 'project.origins_replaced', ?, ?, 'success', ?)`,
    ).bind(crypto.randomUUID(), projectId, now, actor.keyId, JSON.stringify({ count: origins.length })),
  ];
  await env.CONTROL_DB.batch(statements);
}
