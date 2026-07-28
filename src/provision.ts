import type { CloudflareD1, CloudflareResponse, CreateProjectRequest, MiniBaseEnv } from "./contracts";
import { randomToken, sha256 } from "./security";

const projectSchema = [
  "CREATE TABLE IF NOT EXISTS mb_schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  "INSERT OR IGNORE INTO mb_schema_versions (version, applied_at) VALUES (1, datetime('now'))",
];

async function cloudflareRequest<T>(env: MiniBaseEnv, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_D1_API_TOKEN}`,
      "content-type": "application/json",
    },
  });
  const payload = await response.json() as CloudflareResponse<T>;
  if (!response.ok || !payload.success) throw new Error(payload.errors?.[0]?.message ?? "Cloudflare API error");
  return payload.result;
}

export async function provisionProject(env: MiniBaseEnv, input: CreateProjectRequest, idempotencyKey: string) {
  const existing = await env.CONTROL_DB.prepare(
    "SELECT project_id, status FROM provisioning_jobs WHERE idempotency_key = ?",
  ).bind(idempotencyKey).first<{ project_id: string; status: string }>();
  if (existing) return { projectId: existing.project_id, status: existing.status, replayed: true };

  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.CONTROL_DB.prepare(
    "INSERT INTO projects (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, 'provisioning', ?, ?)",
  ).bind(projectId, input.slug, input.name, now, now).run();
  await env.CONTROL_DB.prepare(
    "INSERT INTO provisioning_jobs (idempotency_key, project_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
  ).bind(idempotencyKey, projectId, now, now).run();

  try {
    const database = await cloudflareRequest<CloudflareD1>(env, "/d1/database", {
      method: "POST",
      body: JSON.stringify({
        name: `mb-${input.slug}`,
        ...(input.region ? { primary_location_hint: input.region } : {}),
      }),
    });
    for (const sql of projectSchema) {
      await cloudflareRequest(env, `/d1/database/${database.uuid}/query`, {
        method: "POST",
        body: JSON.stringify({ sql }),
      });
    }

    const publishableKey = randomToken("mb_publishable_");
    const secretKey = randomToken("mb_secret_");
    await env.CONTROL_DB.prepare(
      "INSERT INTO api_keys (id, project_id, kind, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), projectId, "publishable", await sha256(publishableKey), "data:read,data:write", now).run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO api_keys (id, project_id, kind, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), projectId, "secret", await sha256(secretKey), "project:admin", now).run();
    await env.CONTROL_DB.prepare(
      "UPDATE projects SET status = 'active', d1_database_id = ?, updated_at = ? WHERE id = ?",
    ).bind(database.uuid, new Date().toISOString(), projectId).run();
    await env.CONTROL_DB.prepare(
      "UPDATE provisioning_jobs SET status = 'completed', updated_at = ? WHERE idempotency_key = ?",
    ).bind(new Date().toISOString(), idempotencyKey).run();
    await env.CONTROL_DB.prepare(
      "INSERT INTO audit_events (id, project_id, action, created_at) VALUES (?, ?, 'project.provisioned', ?)",
    ).bind(crypto.randomUUID(), projectId, new Date().toISOString()).run();

    return { projectId, status: "active", publishableKey, secretKey, replayed: false };
  } catch (error) {
    await env.CONTROL_DB.prepare(
      "UPDATE projects SET status = 'provisioning_failed', updated_at = ? WHERE id = ?",
    ).bind(new Date().toISOString(), projectId).run();
    await env.CONTROL_DB.prepare(
      "UPDATE provisioning_jobs SET status = 'failed', error_code = 'PROVISIONING_FAILED', updated_at = ? WHERE idempotency_key = ?",
    ).bind(new Date().toISOString(), idempotencyKey).run();
    throw error;
  }
}
