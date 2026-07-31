import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const pathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

export function validateFilePath(value: string): string {
  if (!pathPattern.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/")) {
    throw new Error("invalid_file_path");
  }
  return value;
}

export function validateUpload(request: Request): { size: number; contentType: string } {
  const rawLength = request.headers.get("content-length");
  const size = rawLength === null ? Number.NaN : Number(rawLength);
  if (!Number.isInteger(size) || size < 0) throw new Error("content_length_required");
  if (size > MAX_FILE_BYTES) throw new Error("file_too_large");
  if (!request.body) throw new Error("request_body_required");
  return {
    size,
    contentType: request.headers.get("content-type")?.slice(0, 200) || "application/octet-stream",
  };
}

export const ownerFilePrefix = (principal: DataPrincipal) =>
  principal.subjectHash ? `u_${principal.subjectHash}/` : "";

export const physicalFilePath = (principal: DataPrincipal, path: string) =>
  `${ownerFilePrefix(principal)}${path}`;

const objectKey = (principal: DataPrincipal, path: string) =>
  `${principal.projectId}/${physicalFilePath(principal, path)}`;

export async function uploadFile(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  path: string,
  request: Request,
) {
  const { size, contentType } = validateUpload(request);
  const key = objectKey(principal, path);
  const object = await env.FILES.put(key, request.body!, {
    httpMetadata: { contentType },
    customMetadata: { projectId: principal.projectId },
  });
  if (!object) throw new Error("file_upload_failed");
  const now = new Date().toISOString();
  try {
    await queryProjectD1(
      env, principal.databaseId,
      `INSERT INTO mb_files (path, size, content_type, etag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         size = excluded.size, content_type = excluded.content_type,
         etag = excluded.etag, updated_at = excluded.updated_at`,
      [physicalFilePath(principal, path), size, contentType, object.etag, now, now],
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
    [physicalFilePath(principal, path)],
  );
  if (!metadata.results[0]) throw new Error("file_not_found");
  const object = await env.FILES.get(objectKey(principal, path));
  if (!object?.body) throw new Error("file_not_found");
  const headers = new Headers({
    "content-type": metadata.results[0].content_type || "application/octet-stream",
    "content-length": String(metadata.results[0].size),
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
  await env.FILES.delete(objectKey(principal, path));
  await queryProjectD1(
    env,
    principal.databaseId,
    "DELETE FROM mb_files WHERE path = ?",
    [physicalFilePath(principal, path)],
  );
}

export async function listFiles(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  url: URL,
) {
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
  const after = url.searchParams.get("after") ?? "";
  if (after) validateFilePath(after);
  const prefix = ownerFilePrefix(principal);
  const sql = principal.subjectHash
    ? `SELECT path, size, content_type, etag, created_at, updated_at
         FROM mb_files WHERE path > ? AND path < ? ORDER BY path LIMIT ?`
    : `SELECT path, size, content_type, etag, created_at, updated_at
         FROM mb_files WHERE path > ? ORDER BY path LIMIT ?`;
  const values = principal.subjectHash
    ? [physicalFilePath(principal, after), `${prefix}\uffff`, limit]
    : [after, limit];
  const result = await queryProjectD1<FileRow>(
    env, principal.databaseId,
    sql,
    values,
  );
  const presentPath = (path: string) => principal.subjectHash ? path.slice(prefix.length) : path;
  return {
    files: result.results.map((row) => ({
      path: presentPath(row.path), size: row.size, contentType: row.content_type, etag: row.etag,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    nextAfter: result.results.at(-1) ? presentPath(result.results.at(-1)!.path) : null,
  };
}
