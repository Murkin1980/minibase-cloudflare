import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";
import { DEFAULT_LIMITS, resolveLimits, type MiniBaseLimits } from "./limits";
import { buildPage, parseCursorQuery } from "./pagination";

const pathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

export function validateFilePath(value: string): string {
  if (!pathPattern.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/")) {
    throw new Error("invalid_file_path");
  }
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

/**
 * Counts bytes as they stream through, so the stored size is measured rather
 * than believed. `Content-Length` remains a cheap pre-check that rejects an
 * oversized upload before a single byte is read; the persisted value is what
 * R2 actually received.
 */
function byteCountingStream(source: ReadableStream<Uint8Array>, maxBytes: number) {
  const counter = { bytes: 0, overflowed: false };
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      counter.bytes += chunk.byteLength;
      if (counter.bytes > maxBytes) counter.overflowed = true;
      controller.enqueue(chunk);
    },
  }));
  return { stream, counter };
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
  const { stream, counter } = byteCountingStream(request.body!, limits.maxFileBytes);
  const object = await env.FILES.put(key, stream, {
    httpMetadata: { contentType },
    customMetadata: { projectId: principal.projectId },
  });
  if (!object) throw new Error("file_upload_failed");
  if (counter.overflowed) {
    await env.FILES.delete(key);
    throw new Error("file_too_large");
  }
  const size = counter.bytes;
  const now = new Date().toISOString();
  try {
    await queryProjectD1(
      env, principal.databaseId,
      `INSERT INTO mb_files (path, size, content_type, etag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         size = excluded.size, content_type = excluded.content_type,
         etag = excluded.etag, updated_at = excluded.updated_at`,
      [path, size, contentType, object.etag, now, now],
    );
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }
  return { path, size, contentType, etag: object.etag, updatedAt: now };
}

interface FileRow {
  path: string;
  size: number;
  content_type: string | null;
  etag: string;
  created_at: string;
  updated_at: string;
}

export async function downloadFile(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  path: string,
): Promise<Response> {
  const metadata = await queryProjectD1<FileRow>(
    env, principal.databaseId,
    "SELECT path, size, content_type, etag, created_at, updated_at FROM mb_files WHERE path = ? LIMIT 1",
    [path],
  );
  if (!metadata.results[0]) throw new Error("file_not_found");
  const object = await env.FILES.get(projectObjectKey(principal, path));
  if (!object?.body) throw new Error("file_not_found");
  const headers = new Headers({
    "content-type": metadata.results[0].content_type || "application/octet-stream",
    "content-length": String(object.size),
    etag: object.httpEtag,
    "cache-control": "private, no-store",
  });
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
  const result = await queryProjectD1<FileRow>(
    env, principal.databaseId,
    `SELECT path, size, content_type, etag, created_at, updated_at
       FROM mb_files WHERE path > ? ORDER BY path LIMIT ?`,
    [query.after ?? "", query.limit + 1],
  );
  const page = buildPage(result.results, query.limit, (row) => row.path);
  return {
    files: page.items.map((row) => ({
      path: row.path, size: row.size, contentType: row.content_type, etag: row.etag,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    nextAfter: page.nextAfter,
    hasMore: page.hasMore,
  };
}
