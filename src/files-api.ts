/**
 * File API — legacy mutable files at /v1/files.
 *
 * D1 round-trips (exact, verified against harness + Miniflare):
 *  PUT success:        5 D1 reads (1× SELECT version 7 + 2× SELECT sql FROM sqlite_master + 2× PRAGMA table_info) + 1× R2 PUT streaming SHA + 1× D1 write (INSERT … ON CONFLICT DO UPDATE) = 5 reads + 1 write + 1 R2
 *  PUT schema failure: 5 D1 reads (same as above, may short-circuit earlier on missing table/column) → file_schema_not_ready, 0 R2, 0 write
 *  PUT oversized (lying CL): stream errors during R2 PUT → R2 does not create object, 413 file_too_large, no unconditional delete that could erase valid concurrent winner
 *  GET success:        1× SELECT mb_files WHERE path = ? (+1 fallback SELECT without new cols if v6) + 1× R2 GET = 1-2 D1 reads + 1 R2
 *  DELETE:             1× R2 DELETE + 1× D1 DELETE FROM mb_files = 1 R2 + 1 D1 write
 *  LIST:               1× SELECT mb_files WHERE path > ? ORDER BY path LIMIT ? (+1 fallback if v6) = 1-2 D1 reads
 *  RECONCILE files:    1× SELECT path FROM mb_files ORDER BY path LIMIT 1000 + 1× R2 LIST prefix {projectId}/ (filtered to exclude artifact prefix) = 1 D1 read + 1 R2
 *
 * All limits (maxFileBytes) are per-project via principal.limits.
 */
import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";
import { DEFAULT_LIMITS, resolveLimits, type MiniBaseLimits } from "./limits";
import { buildPage, parseCursorQuery } from "./pagination";
import { createHashingStream } from "./file-hash";
import { assertFilePathNotArtifact, parseEntityHeaders } from "./artifacts";
import { assertV7ReadyForWrite } from "./project-schema";

const pathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

export function validateFilePath(value: string): string {
  if (!pathPattern.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/")) {
    throw new Error("invalid_file_path");
  }
  assertFilePathNotArtifact(value);
  return value;
}

export function validateUpload(
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

/**
 * R2 object key for a file. The project ID prefix always comes from the
 * authenticated principal, never from the request, so one project cannot name
 * another project's object. This is the whole of MiniBase's file isolation.
 */
export function projectObjectKey(principal: DataPrincipal, path: string): string {
  return `${principal.projectId}/${path}`;
}

export async function uploadFile(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  path: string,
  request: Request,
  limits: MiniBaseLimits = resolveLimits(env),
) {
  const { contentType } = validateUpload(request, limits);
  const key = projectObjectKey(principal, path);
  const entity = parseEntityHeaders(request);
  // Precise v7 readiness before any R2 write — no legacy fallback, deterministic 409.
  // Transport errors (cloudflare_api_error) propagate as 502, not masked as schema mismatch.
  await assertV7ReadyForWrite(env, principal.databaseId);
  const { stream, counter, shaPromise } = createHashingStream(request.body!, limits.maxFileBytes);
  // Single owner: mark observed to avoid unhandledRejection if we throw before await
  void shaPromise.catch(() => {});
  let object: Awaited<ReturnType<MiniBaseEnv["FILES"]["put"]>>;
  try {
    object = await env.FILES.put(key, stream, {
      httpMetadata: { contentType },
      customMetadata: { projectId: principal.projectId },
    });
  } catch (error) {
    if (counter.overflowed) {
      void shaPromise.catch(() => {});
      throw new Error("file_too_large");
    }
    void shaPromise.catch(() => {});
    throw error;
  }
  if (!object) {
    // Conditional failure is not possible for files (mutable), but keep for type safety
    void shaPromise.catch(() => {});
    throw new Error("file_upload_failed");
  }
  // With new streaming, overflow errors during R2 PUT and put throws, so this after-R2 check
  // is only a safety net. Do not unconditionally delete to avoid erasing a valid concurrent winner's object.
  if (counter.overflowed) {
    void shaPromise.catch(() => {});
    throw new Error("file_too_large");
  }
  let checksumSha256: string;
  try {
    checksumSha256 = await shaPromise;
  } catch (error) {
    // Source/read/write error after R2 success: delete the object we created
    try { await env.FILES.delete(key); } catch { /* ignore */ }
    throw error;
  }
  const size = counter.bytes;
  const now = new Date().toISOString();
  const uploadedAt = now;
  try {
    await queryProjectD1(
      env, principal.databaseId,
      `INSERT INTO mb_files (path, size, content_type, etag, created_at, updated_at, checksum_sha256, uploaded_at, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         size = excluded.size, content_type = excluded.content_type,
         etag = excluded.etag, updated_at = excluded.updated_at,
         checksum_sha256 = excluded.checksum_sha256, uploaded_at = excluded.uploaded_at,
         entity_type = excluded.entity_type, entity_id = excluded.entity_id`,
      [path, size, contentType, object.etag, now, now, checksumSha256, uploadedAt, entity?.entityType ?? null, entity?.entityId ?? null],
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Transport errors must not be masked; only schema mismatch is 409, others are 502
    if (msg === "file_schema_not_ready") throw error;
    if (msg === "cloudflare_api_error" || msg.includes("transport failed")) {
      await env.FILES.delete(key);
      throw error;
    }
    await env.FILES.delete(key);
    throw error;
  }
  return {
    path,
    size,
    contentType,
    etag: object.etag,
    updatedAt: now,
    checksumSha256,
    uploadedAt,
    entityType: entity?.entityType ?? null,
    entityId: entity?.entityId ?? null,
  };
}

export interface FileRow {
  path: string;
  size: number;
  content_type: string | null;
  etag: string;
  created_at: string;
  updated_at: string;
  checksum_sha256?: string | null;
  uploaded_at?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
}

export async function downloadFile(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  path: string,
): Promise<Response> {
  const metadata = await queryProjectD1<FileRow>(
    env, principal.databaseId,
    "SELECT path, size, content_type, etag, created_at, updated_at, checksum_sha256, uploaded_at, entity_type, entity_id FROM mb_files WHERE path = ? LIMIT 1",
    [path],
  ).catch(async (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("no such column")) {
      // Fallback for v6 database: select without new columns
      return queryProjectD1<FileRow>(
        env, principal.databaseId,
        "SELECT path, size, content_type, etag, created_at, updated_at FROM mb_files WHERE path = ? LIMIT 1",
        [path],
      );
    }
    throw error;
  });
  if (!metadata.results[0]) throw new Error("file_not_found");
  const object = await env.FILES.get(projectObjectKey(principal, path));
  if (!object?.body) throw new Error("file_not_found");
  const row = metadata.results[0];
  const headers = new Headers({
    "content-type": row.content_type || "application/octet-stream",
    "content-length": String(object.size),
    etag: object.httpEtag,
    "cache-control": "private, no-store",
  });
  if (row.checksum_sha256) headers.set("x-minibase-sha256", row.checksum_sha256);
  if (row.uploaded_at) headers.set("x-minibase-uploaded-at", row.uploaded_at);
  if (row.entity_type) headers.set("x-minibase-entity-type", row.entity_type);
  if (row.entity_id) headers.set("x-minibase-entity-id", row.entity_id);
  return new Response(object.body, { headers });
}

export async function deleteFile(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  path: string,
): Promise<void> {
  await env.FILES.delete(projectObjectKey(principal, path));
  await queryProjectD1(env, principal.databaseId, "DELETE FROM mb_files WHERE path = ?", [path]);
}

export async function listFiles(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  url: URL,
  limits: MiniBaseLimits = resolveLimits(env),
) {
  const query = parseCursorQuery(url, limits, validateFilePath);
  let result: { results: FileRow[] };
  try {
    result = await queryProjectD1<FileRow>(
      env, principal.databaseId,
      `SELECT path, size, content_type, etag, created_at, updated_at, checksum_sha256, uploaded_at, entity_type, entity_id
       FROM mb_files WHERE path > ? ORDER BY path LIMIT ?`,
      [query.after ?? "", query.limit + 1],
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("no such column")) {
      result = await queryProjectD1<FileRow>(
        env, principal.databaseId,
        `SELECT path, size, content_type, etag, created_at, updated_at
         FROM mb_files WHERE path > ? ORDER BY path LIMIT ?`,
        [query.after ?? "", query.limit + 1],
      );
    } else {
      throw error;
    }
  }
  const page = buildPage(result.results, query.limit, (row) => row.path);
  return {
    files: page.items.map((row) => ({
      path: row.path, size: row.size, contentType: row.content_type, etag: row.etag,
      createdAt: row.created_at, updatedAt: row.updated_at,
      checksumSha256: (row as FileRow).checksum_sha256 ?? null,
      uploadedAt: (row as FileRow).uploaded_at ?? null,
      entityType: (row as FileRow).entity_type ?? null,
      entityId: (row as FileRow).entity_id ?? null,
    })),
    nextAfter: page.nextAfter,
    hasMore: page.hasMore,
  };
}
