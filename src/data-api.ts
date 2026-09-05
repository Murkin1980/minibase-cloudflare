import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";
import { DEFAULT_LIMITS, type MiniBaseLimits } from "./limits";
import { buildPage, parseCursorQuery, type CursorQuery } from "./pagination";
import {
  buildRecordStatement,
  encodeRecordCursor,
  parseRecordQuery,
  presentRecord,
  sortValueOf,
  type RecordQuery,
  type StoredRecordRow,
} from "./record-query";

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

export function parseListQuery(url: URL, limits: MiniBaseLimits = DEFAULT_LIMITS): CursorQuery {
  return parseCursorQuery(url, limits, validateRecordId);
}

/** CP-04: the validated `GET /v1/data/{collection}` query. */
export function parseRecordListQuery(
  url: URL,
  collection: string,
  limits: MiniBaseLimits = DEFAULT_LIMITS,
): RecordQuery {
  return parseRecordQuery(url, limits, collection);
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
  id: row.id,
  data: JSON.parse(row.data) as unknown,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Lists one collection as a single keyset page.
 *
 * Ordering is whatever the validated query selected, always with `id` as the
 * final tie-breaker, so records sharing a timestamp can neither be skipped nor
 * repeated across pages. `hasMore` comes from a `limit + 1` probe row, and the
 * whole page still costs exactly one D1 REST round trip. A request that used no
 * CP-04 parameter produces the pre-CP-04 statement, response, and cursor.
 */
export async function listRecords(
  env: MiniBaseEnv,
  principal: DataPrincipal,
  collection: string,
  query: RecordQuery,
) {
  const statement = buildRecordStatement(collection, query);
  const result = await queryProjectD1<StoredRecordRow>(
    env,
    principal.databaseId,
    statement.sql,
    statement.params,
  );
  const page = buildPage(result.results, query.limit, (row) =>
    encodeRecordCursor(query, collection, sortValueOf(query, row), row.id));
  return {
    records: page.items.map((row) => presentRecord(row, query.select)),
    nextAfter: page.nextAfter,
    hasMore: page.hasMore,
  };
}

export async function getRecord(env: MiniBaseEnv, principal: DataPrincipal, collection: string, id: string) {
  const result = await queryProjectD1<RecordRow>(
    env, principal.databaseId,
    "SELECT id, data, created_at, updated_at FROM mb_records WHERE collection = ? AND id = ? LIMIT 1",
    [collection, id],
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
    [collection, id, JSON.stringify(data), now, now],
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
    [collection, id],
  );
}
