/**
 * Artifact API — immutable originals at /v1/artifacts/originals/:id.
 *
 * D1 round-trips (exact, verified against harness + Miniflare):
 *  PUT success:         5 D1 reads (1× SELECT version 7 + 2× SELECT sql + 2× PRAGMA) + 1× R2 PUT onlyIf etagDoesNotMatch:* streaming SHA + 1× D1 write (INSERT no UPSERT) = 5 reads + 1 write + 1 R2. SHA and size measured, not trusted.
 *  PUT conflict:        5 D1 reads + 1× R2 PUT returns null → 409 artifact_already_exists, 0 D1 writes, no cleanup, digest cancelled via ReadableStream cancel → shaPromise rejects but observed
 *  PUT schema failure:  5 D1 reads (may short-circuit) → file_schema_not_ready, 0 R2, 0 D1 writes
 *  PUT D1 UNIQUE fail after R2: 5 reads + 1 R2 + 1 D1 write attempt fails UNIQUE → 409, orphan left, no delete
 *  PUT oversized (lying CL): stream errors during R2 PUT → R2 does not create object, 409 takes precedence if conditional, else 413 file_too_large, no unconditional delete that could erase valid concurrent winner
 *  GET success:         1× SELECT mb_artifacts WHERE artifact_id = ? + 1× R2 GET = 1 D1 read + 1 R2
 *  GET not found:       1× SELECT returns empty → 404, 0 R2; or SELECT ok + R2 miss → 404
 *  No LIST/DELETE for originals
 *  RECONCILE artifacts: 1× SELECT artifact_id … FROM mb_artifacts ORDER BY artifact_id LIMIT 1000 + 1× R2 LIST prefix {projectId}/.mb_artifacts/originals/ + 1× SELECT legacy files WHERE checksum_sha256 IS NULL = 2 D1 reads + 1 R2 (or 1 D1 read +1 R2 if table not ready)
 */
import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";
import { DEFAULT_LIMITS, resolveLimits, type MiniBaseLimits } from "./limits";
import { createHashingStream } from "./file-hash";
import { artifactObjectKey, parseEntityHeaders, validateArtifactId } from "./artifacts";
import { assertV7ReadyForWrite } from "./project-schema";

export function validateArtifactUpload(
  request: Request,
  limits: MiniBaseLimits = DEFAULT_LIMITS,
): { size: number; contentType: string } {
  const rawLength = request.headers.get("content-length");
  const size = rawLength === null ? Number.NaN : Number(rawLength);
  if (!Number.isInteger(size) || size < 0) throw new Error("content_length_required");
  if (size > limits.maxFileBytes) throw new Error("file_too_large");
  if (!request.body) throw new Error("request_body_required");
  return {
    size,
    contentType: request.headers.get("content-type")?.slice(0, 200) || "application/octet-stream",
  };
}

export async function uploadOriginalArtifact(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  artifactId: string,
  request: Request,
  limits: MiniBaseLimits = resolveLimits(env),
) {
  validateArtifactId(artifactId);
  const { contentType } = validateArtifactUpload(request, limits);
  const entity = parseEntityHeaders(request);
  const key = artifactObjectKey(principal, artifactId);

  // Precise V7 readiness before any R2 write — checks version row, table sql, columns, PK/UNIQUE.
  // Transport errors (cloudflare_api_error) propagate as 502, not masked as 409.
  await assertV7ReadyForWrite(env, principal.databaseId);

  const { stream, counter, shaPromise } = createHashingStream(request.body!, limits.maxFileBytes);
  // Single owner: mark observed to avoid unhandledRejection if we throw before awaiting.
  void shaPromise.catch(() => {});

  let object: Awaited<ReturnType<MiniBaseEnv["FILES"]["put"]>> | null;
  try {
    object = await env.FILES.put(key, stream, {
      httpMetadata: { contentType },
      customMetadata: { projectId: principal.projectId },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch (error) {
    // Stream error (overflow, source error, digest error) aborts R2 PUT.
    // If overflowed, translate to file_too_large without deleting (R2 did not create object).
    if (counter.overflowed) {
      void shaPromise.catch(() => {});
      throw new Error("file_too_large");
    }
    // Ensure shaPromise is observed (already void caught, but await to settle)
    void shaPromise.catch(() => {});
    throw error;
  }

  // Conditional failure → deterministic 409, no D1 mutation, no cleanup.
  // R2 did not consume the stream fully (412). The ReadableStream cancel aborts the DigestStream writer
  // and causes shaPromise to reject, but we have already observed it.
  if (object === null) {
    void shaPromise.catch(() => undefined);
    throw new Error("artifact_already_exists");
  }

  // With new streaming, overflow is detected during R2 PUT and causes put to throw, so this
  // after-R2 check is no longer the primary path. Keep as safety for any edge where R2 succeeded
  // but counter still overflowed (e.g., exact limit+1 on final chunk after R2 buffered).
  // Do NOT unconditionally delete — that would erase a valid concurrent winner's object.
  // Instead, throw file_too_large without delete and document that concurrent valid that lost
  // with 409 can retry after oversized is gone (or reconciler cleans orphan).
  if (counter.overflowed) {
    void shaPromise.catch(() => {});
    throw new Error("file_too_large");
  }

  let checksumSha256: string;
  try {
    checksumSha256 = await shaPromise;
  } catch (error) {
    // Source/read/write error after R2 success: delete the object we created, since no D1 row yet
    try { await env.FILES.delete(key); } catch { /* ignore */ }
    throw error;
  }

  const size = counter.bytes;
  const now = new Date().toISOString();

  // D1 plain INSERT, no UPSERT. Immutable.
  try {
    await queryProjectD1(
      env,
      principal.databaseId,
      `INSERT INTO mb_artifacts (artifact_id, storage_key, size, content_type, etag, checksum_sha256, uploaded_at, entity_type, entity_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifactId,
        key,
        size,
        contentType,
        object.etag,
        checksumSha256,
        now,
        entity?.entityType ?? null,
        entity?.entityId ?? null,
        now,
      ],
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("UNIQUE") || msg.includes("constraint") || msg.includes("PRIMARY KEY")) {
      throw new Error("artifact_already_exists");
    }
    if (msg === "file_schema_not_ready" || msg.includes("no such table")) {
      throw new Error("file_schema_not_ready");
    }
    if (msg === "cloudflare_api_error" || msg.includes("transport failed")) {
      // D1 failure after R2 success → orphan, no delete
      throw error;
    }
    // Other D1 errors also leave orphan per spec
    throw error;
  }

  return {
    artifactId,
    size,
    contentType,
    etag: object.etag,
    checksumSha256,
    uploadedAt: now,
    entityType: entity?.entityType ?? null,
    entityId: entity?.entityId ?? null,
    createdAt: now,
  };
}

export interface ArtifactRow {
  artifact_id: string;
  storage_key: string;
  size: number;
  content_type: string | null;
  etag: string;
  checksum_sha256: string;
  uploaded_at: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
}

export async function downloadOriginalArtifact(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  artifactId: string,
): Promise<Response> {
  validateArtifactId(artifactId);
  let row: ArtifactRow | null = null;
  try {
    const meta = await queryProjectD1<ArtifactRow>(
      env,
      principal.databaseId,
      "SELECT artifact_id, storage_key, size, content_type, etag, checksum_sha256, uploaded_at, entity_type, entity_id, created_at FROM mb_artifacts WHERE artifact_id = ? LIMIT 1",
      [artifactId],
    );
    row = meta.results[0] ?? null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "cloudflare_api_error" || msg.includes("transport failed")) throw error;
    if (msg.includes("no such table")) throw new Error("file_schema_not_ready");
    throw error;
  }
  if (!row) throw new Error("artifact_not_found");
  const key = artifactObjectKey(principal, artifactId);
  const object = await env.FILES.get(key);
  if (!object?.body) throw new Error("artifact_not_found");
  const headers = new Headers({
    "content-type": row.content_type || "application/octet-stream",
    "content-length": String(object.size),
    etag: object.httpEtag,
    "cache-control": "private, no-store",
    "x-minibase-sha256": row.checksum_sha256,
    "x-minibase-uploaded-at": row.uploaded_at,
  });
  if (row.entity_type) headers.set("x-minibase-entity-type", row.entity_type);
  if (row.entity_id) headers.set("x-minibase-entity-id", row.entity_id);
  return new Response(object.body, { headers });
}
