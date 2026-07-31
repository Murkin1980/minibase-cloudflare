import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";

const collectionPattern = /^[a-z][a-z0-9_-]{1,62}$/;
const recordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateCollection(value: string): string {
  if (!collectionPattern.test(value)) throw new Error("invalid_collection");
  return value;
}

export function validateRecordId(value: string): string {
  if (!recordIdPattern.test(value)) throw new Error("invalid_record_id");
  return value;
}

export function parseListQuery(url: URL): { limit: number; after?: string } {
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
  const after = url.searchParams.get("after");
  if (after) validateRecordId(after);
  return { limit, ...(after ? { after } : {}) };
}

export function validateRecordData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_record_data");
  return value as Record<string, unknown>;
}

interface RecordRow {
  id: string;
  data: string;
  created_at: string;
  updated_at: string;
}

const present = (row: RecordRow) => ({
  id: row.id.includes(":") && row.id.startsWith("u_") ? row.id.slice(row.id.indexOf(":") + 1) : row.id,
  data: JSON.parse(row.data) as unknown,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const ownerPrefix = (principal: DataPrincipal) =>
  principal.subjectHash ? `u_${principal.subjectHash}:` : "";

export const physicalRecordId = (principal: DataPrincipal, id: string) =>
  `${ownerPrefix(principal)}${id}`;

export async function listRecords(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  collection: string,
  query: { limit: number; after?: string },
) {
  const prefix = ownerPrefix(principal);
  const sql = principal.subjectHash
    ? `SELECT id, data, created_at, updated_at FROM mb_records
        WHERE collection = ? AND id > ? AND id < ?
        ORDER BY id LIMIT ?`
    : `SELECT id, data, created_at, updated_at FROM mb_records
        WHERE collection = ? AND id > ? ORDER BY id LIMIT ?`;
  const values = principal.subjectHash
    ? [collection, physicalRecordId(principal, query.after ?? ""), `${prefix}\uffff`, query.limit]
    : [collection, query.after ?? "", query.limit];
  const result = await queryProjectD1<RecordRow>(
    env,
    principal.databaseId,
    sql,
    values,
  );
  return {
    records: result.results.map(present),
    nextAfter: result.results.at(-1) ? present(result.results.at(-1)!).id : null,
  };
}

export async function getRecord(env: MiniBaseEnv, principal: DataPrincipal, collection: string, id: string) {
  const result = await queryProjectD1<RecordRow>(
    env, principal.databaseId,
    "SELECT id, data, created_at, updated_at FROM mb_records WHERE collection = ? AND id = ? LIMIT 1",
    [collection, physicalRecordId(principal, id)],
  );
  if (!result.results[0]) throw new Error("record_not_found");
  return present(result.results[0]);
}

export async function putRecord(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  collection: string,
  id: string,
  data: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  await queryProjectD1(
    env, principal.databaseId,
    `INSERT INTO mb_records (collection, id, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [collection, physicalRecordId(principal, id), JSON.stringify(data), now, now],
  );
  return { id, data, updatedAt: now };
}

export async function deleteRecord(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  collection: string,
  id: string,
): Promise<void> {
  await queryProjectD1(
    env, principal.databaseId,
    "DELETE FROM mb_records WHERE collection = ? AND id = ?",
    [collection, physicalRecordId(principal, id)],
  );
}
