import type { CloudflareD1, CloudflareResponse, CreateProjectRequest, MiniBaseEnv } from "./contracts";
import { projectSchemaMigrations } from "./project-schema";
import { randomToken, sha256 } from "./security";

const projectSchema = projectSchemaMigrations.flatMap((migration) => migration.statements);
const currentProjectSchemaVersion = projectSchemaMigrations.at(-1)?.version ?? 0;

interface ExistingJob {
  project_id: string;
  status: string;
  request_hash: string | null;
  rollback_status: string | null;
}

export async function provisioningFingerprint(input: CreateProjectRequest): Promise<string> {
  return sha256(JSON.stringify({
    slug: input.slug,
    name: input.name,
    region: input.region ?? null,
  }));
}

async function cloudflareRequest<T>(env: MiniBaseEnv, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_D1_API_TOKEN}`,
      "content-type": "application/json",
    },
  });
  const payload = await response.json() as CloudflareResponse<T>;
  if (!response.ok || !payload.success) throw new Error("cloudflare_api_error");
  return payload.result;
}

function replay(existing: ExistingJob, requestHash: string) {
  if (existing.request_hash && existing.request_hash !== requestHash) {
    throw new Error("idempotency_key_reused_with_different_request");
  }
  return {
    projectId: existing.project_id,
    status: existing.status,
    rollbackStatus: existing.rollback_status,
    replayed: true,
  };
}

export async function provisionProject(
  env: MiniBaseEnv,
  input: CreateProjectRequest,
  idempotencyKey: string,
  actorKeyId: string,
) {
  const requestHash = await provisioningFingerprint(input);
  const findJob = () => env.CONTROL_DB.prepare(
    `SELECT project_id, status, request_hash, rollback_status
       FROM provisioning_jobs
      WHERE idempotency_key = ?`,
  ).bind(idempotencyKey).first<ExistingJob>();
  const existing = await findJob();
  if (existing) return replay(existing, requestHash);

  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO projects (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, 'provisioning', ?, ?)",
      ).bind(projectId, input.slug, input.name, now, now),
      env.CONTROL_DB.prepare(
        `INSERT INTO provisioning_jobs
          (idempotency_key, project_id, status, request_hash, rollback_status, created_at, updated_at)
         VALUES (?, ?, 'running', ?, 'not_required', ?, ?)`,
      ).bind(idempotencyKey, projectId, requestHash, now, now),
    ]);
  } catch (error) {
    const racedJob = await findJob();
    if (racedJob) return replay(racedJob, requestHash);
    throw error;
  }

  let databaseId: string | null = null;
  try {
    const database = await cloudflareRequest<CloudflareD1>(env, "/d1/database", {
      method: "POST",
      body: JSON.stringify({
        name: `mb-${input.slug}`,
        ...(input.region ? { primary_location_hint: input.region } : {}),
      }),
    });
    databaseId = database.uuid;
    await env.CONTROL_DB.prepare(
      "UPDATE provisioning_jobs SET d1_database_id = ?, updated_at = ? WHERE idempotency_key = ?",
    ).bind(databaseId, new Date().toISOString(), idempotencyKey).run();

    for (const sql of projectSchema) {
      await cloudflareRequest(env, `/d1/database/${databaseId}/query`, {
        method: "POST",
        body: JSON.stringify({ sql }),
      });
    }

    const publishableKey = randomToken("mb_publishable_");
    const secretKey = randomToken("mb_secret_");
    const completedAt = new Date().toISOString();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO api_keys (id, project_id, kind, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), projectId, "publishable", await sha256(publishableKey), "data:read,data:write", now),
      env.CONTROL_DB.prepare(
        "INSERT INTO api_keys (id, project_id, kind, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), projectId, "secret", await sha256(secretKey), "project:admin", now),
      env.CONTROL_DB.prepare(
        `UPDATE projects
            SET status = 'active', d1_database_id = ?, data_schema_version = ?, updated_at = ?
          WHERE id = ?`,
      ).bind(databaseId, currentProjectSchemaVersion, completedAt, projectId),
      env.CONTROL_DB.prepare(
        "UPDATE provisioning_jobs SET status = 'completed', updated_at = ? WHERE idempotency_key = ?",
      ).bind(completedAt, idempotencyKey),
      env.CONTROL_DB.prepare(
        `INSERT INTO audit_events
          (id, project_id, action, created_at, actor_key_id, outcome)
         VALUES (?, ?, 'project.provisioned', ?, ?, 'success')`,
      ).bind(crypto.randomUUID(), projectId, completedAt, actorKeyId),
    ]);

    return { projectId, status: "active", publishableKey, secretKey, replayed: false };
  } catch (error) {
    let rollbackStatus: "not_required" | "completed" | "failed" = "not_required";
    if (databaseId) {
      try {
        await cloudflareRequest(env, `/d1/database/${databaseId}`, { method: "DELETE" });
        rollbackStatus = "completed";
      } catch {
        rollbackStatus = "failed";
      }
    }
    const failedAt = new Date().toISOString();
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "UPDATE projects SET status = 'provisioning_failed', d1_database_id = ?, updated_at = ? WHERE id = ?",
      ).bind(rollbackStatus === "failed" ? databaseId : null, failedAt, projectId),
      env.CONTROL_DB.prepare(
        `UPDATE provisioning_jobs
            SET status = 'failed', error_code = 'PROVISIONING_FAILED',
                rollback_status = ?, d1_database_id = ?, updated_at = ?
          WHERE idempotency_key = ?`,
      ).bind(rollbackStatus, rollbackStatus === "failed" ? databaseId : null, failedAt, idempotencyKey),
      env.CONTROL_DB.prepare(
        `INSERT INTO audit_events
          (id, project_id, action, created_at, actor_key_id, outcome, metadata)
         VALUES (?, ?, 'project.provisioning_failed', ?, ?, 'failed', ?)`,
      ).bind(
        crypto.randomUUID(),
        projectId,
        failedAt,
        actorKeyId,
        JSON.stringify({ rollbackStatus }),
      ),
    ]);
    throw error;
  }
}
