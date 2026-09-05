import type { MiniBaseLimits } from "./limits";

/**
 * CP-04 record query contract.
 *
 * MiniBase is not an SQL gateway. Nothing a caller sends ever becomes SQL text:
 * every column name, operator, and sort direction below is chosen by the server
 * from a static allowlist, and every value travels as a bind parameter. A field,
 * operator, order, or cursor MiniBase does not know is rejected with a
 * deterministic 400 — never ignored, never silently dropped.
 *
 * The allowlists are deliberately short. A field is listed only when a real
 * consumer need was found in the repository (see `docs/DATA_API.md` §Query),
 * because an index without a query that uses it is waste, and a filter without
 * an index is a full collection scan charged to the project's D1 quota.
 */

const recordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * An ISO-8601 instant with an **explicit** timezone.
 *
 * `created_at` and `updated_at` are always written by `new Date().toISOString()`,
 * so every stored value is canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. SQLite
 * compares those columns as TEXT, which means a filter value in any other
 * representation compares lexicographically against a different shape and
 * silently returns the wrong rows — `2026-09-01T00:00:00+05:00` sorts after
 * `2026-09-01T00:00:00.000Z` as text even though it is the earlier instant, and
 * a value with no timezone is not a defined instant at all.
 *
 * So a filter value is required to carry a timezone and is normalized to the
 * one canonical UTC form before it is bound. Two spellings of the same instant
 * therefore produce byte-identical SQL parameters, and filtering, ordering, and
 * keyset pagination all stay consistent with the stored representation.
 */
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validates an instant and returns it as canonical UTC.
 *
 * `Date.parse` alone is not enough: it accepts `2026-02-30` by rolling it over
 * into March, so the round trip below is what rejects a date that does not
 * exist rather than quietly shifting the caller's filter.
 */
export function normalizeTimestamp(raw: string): string {
  if (!timestampPattern.test(raw)) throw new Error("invalid_filter");
  const parsed = new Date(raw);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) throw new Error("invalid_filter");
  // Compare the calendar fields the caller wrote against the ones that survived
  // parsing, in the caller's own offset, so a rolled-over date is caught.
  const offsetMatch = /(Z|[+-]\d{2}:\d{2})$/.exec(raw)![1];
  const offsetMinutes = offsetMatch === "Z"
    ? 0
    : (offsetMatch.startsWith("-") ? -1 : 1) *
      (Number(offsetMatch.slice(1, 3)) * 60 + Number(offsetMatch.slice(4, 6)));
  const local = new Date(time + offsetMinutes * 60_000);
  const written = raw.slice(0, 10);
  const round = local.toISOString().slice(0, 10);
  if (written !== round) throw new Error("invalid_filter");
  return parsed.toISOString();
}

export type FilterOperator = "eq" | "gt" | "gte" | "lt" | "lte";

const operatorSql: Record<FilterOperator, string> = {
  eq: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

interface FieldSpec {
  /** Static SQL expression. Never built from caller input. */
  readonly sql: string;
  readonly operators: readonly FilterOperator[];
  readonly parse: (raw: string) => string | number;
}

const timestampField = (sql: string): FieldSpec => ({
  sql,
  operators: ["eq", "gt", "gte", "lt", "lte"],
  parse: normalizeTimestamp,
});

/**
 * Filterable fields.
 *
 * `schemaVersion` is read through a fixed JSON path with an expression index
 * behind it (project schema v5). It is the only JSON field with a confirmed
 * consumer need — every stored document shape in the onboarding brief carries
 * `schemaVersion`, and rolling documents forward requires selecting by it.
 */
const filterFields: Record<string, FieldSpec> = {
  id: {
    sql: "id",
    operators: ["eq"],
    parse(raw) {
      if (!recordIdPattern.test(raw)) throw new Error("invalid_filter");
      return raw;
    },
  },
  createdAt: timestampField("created_at"),
  updatedAt: timestampField("updated_at"),
  schemaVersion: {
    sql: "json_extract(data, '$.schemaVersion')",
    operators: ["eq"],
    parse(raw) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 1_000_000) throw new Error("invalid_filter");
      return value;
    },
  },
};

/** Orderable fields. Each one has a composite index ending in `id` (schema v5). */
const orderFields: Record<string, string> = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

/** Response fields a caller may ask for. Internal columns are unreachable by name. */
const selectFields = ["id", "data", "createdAt", "updatedAt"] as const;
export type SelectField = (typeof selectFields)[number];

export interface RecordFilter {
  field: string;
  operator: FilterOperator;
  value: string | number;
}

export interface RecordQuery {
  limit: number;
  filters: RecordFilter[];
  orderField: string;
  direction: "asc" | "desc";
  select: SelectField[];
  /** Keyset position: the previous page's last `[sortValue, id]`. */
  after?: { sortValue: string | number | null; id: string };
  /**
   * True when the request used none of the CP-04 parameters, so the pre-CP-04
   * contract applies verbatim: order by id, cursor is the bare record id.
   */
  legacy: boolean;
}

export const defaultSelect: SelectField[] = [...selectFields];

/* ------------------------------------------------------------------ cursor */

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/**
 * A query-consistency digest: the cursor is bound to the query that produced it.
 *
 * This is FNV-1a, **not** a cryptographic signature. It is not a security
 * control, does not authenticate a cursor, and does not prevent deliberate
 * modification — a caller who wants to can construct a cursor that passes it.
 * That is acceptable because it protects nothing: the project is still resolved
 * from the key alone, every cursor value is bound as a parameter, and the id
 * and sort value are re-validated on the way in. Its only job is to turn
 * "page 2 of a different filter/order" into a deterministic 400 instead of a
 * silently wrong page.
 */
function queryDigest(query: Pick<RecordQuery, "filters" | "orderField" | "direction">, collection: string): string {
  const canonical = JSON.stringify([
    collection,
    query.orderField,
    query.direction,
    query.filters.map((filter) => [filter.field, filter.operator, filter.value]),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function encodeRecordCursor(
  query: RecordQuery,
  collection: string,
  sortValue: string | number | null,
  id: string,
): string {
  if (query.legacy) return id;
  return `mbq1.${base64UrlEncode(JSON.stringify([queryDigest(query, collection), sortValue, id]))}`;
}

function decodeRecordCursor(
  raw: string,
  query: Pick<RecordQuery, "filters" | "orderField" | "direction">,
  collection: string,
): { sortValue: string | number | null; id: string } {
  if (!raw.startsWith("mbq1.")) throw new Error("invalid_cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw.slice(5)));
  } catch {
    throw new Error("invalid_cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error("invalid_cursor");
  const [digest, sortValue, id] = parsed as [unknown, unknown, unknown];
  if (digest !== queryDigest(query, collection)) throw new Error("invalid_cursor");
  if (typeof id !== "string" || !recordIdPattern.test(id)) throw new Error("invalid_cursor");
  if (sortValue !== null && typeof sortValue !== "string" && typeof sortValue !== "number") {
    throw new Error("invalid_cursor");
  }
  return { sortValue, id };
}

/* ------------------------------------------------------------------- parse */

function parseFilters(url: URL): RecordFilter[] {
  const filters: RecordFilter[] = [];
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => entries.push([key, value]));
  for (const [key, raw] of entries) {
    const match = /^filter\[([^\]]*)\]$/.exec(key);
    if (!match) continue;
    const [field, operatorName = "eq", ...rest] = match[1].split(".");
    if (rest.length > 0) throw new Error("invalid_filter");
    const spec = Object.prototype.hasOwnProperty.call(filterFields, field) ? filterFields[field] : undefined;
    if (!spec) throw new Error("invalid_filter");
    if (!(operatorName in operatorSql)) throw new Error("invalid_operator");
    const operator = operatorName as FilterOperator;
    if (!spec.operators.includes(operator)) throw new Error("invalid_operator");
    const seenKey = `${field}.${operator}`;
    if (seen.has(seenKey)) throw new Error("invalid_filter");
    seen.add(seenKey);
    filters.push({ field, operator, value: spec.parse(raw) });
  }
  // Stable order keeps the cursor digest independent of query-string order.
  return filters.sort((left, right) => `${left.field}.${left.operator}`.localeCompare(`${right.field}.${right.operator}`));
}

function parseSelect(url: URL): SelectField[] {
  const raw = url.searchParams.get("select");
  if (raw === null) return defaultSelect;
  const requested = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  if (requested.length === 0) throw new Error("invalid_select");
  const chosen: SelectField[] = [];
  for (const field of requested) {
    if (!(selectFields as readonly string[]).includes(field)) throw new Error("invalid_select");
    if (!chosen.includes(field as SelectField)) chosen.push(field as SelectField);
  }
  return chosen;
}

/**
 * Parses `GET /v1/data/{collection}` into a fully validated query.
 *
 * A request that carries none of `filter[...]`, `order`, or `select` is parsed
 * as the pre-CP-04 list, down to the cursor format, so an existing client keeps
 * its exact previous behaviour.
 */
export function parseRecordQuery(url: URL, limits: MiniBaseLimits, collection: string): RecordQuery {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? limits.defaultPageSize : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxPageSize) throw new Error("invalid_limit");

  const filters = parseFilters(url);
  const select = parseSelect(url);

  const rawOrder = url.searchParams.get("order");
  let orderField = "id";
  let direction: "asc" | "desc" = "asc";
  if (rawOrder !== null) {
    const [field, directionName = "asc", ...rest] = rawOrder.split(".");
    if (rest.length > 0) throw new Error("invalid_order");
    if (!Object.prototype.hasOwnProperty.call(orderFields, field)) throw new Error("invalid_order");
    if (directionName !== "asc" && directionName !== "desc") throw new Error("invalid_order");
    orderField = field;
    direction = directionName;
  }

  // `select` alone does not change ordering or the cursor, so it does not move a
  // caller off the legacy contract.
  const legacy = filters.length === 0 && rawOrder === null;
  const base = { limit, filters, orderField, direction, select, legacy };

  const after = url.searchParams.get("after");
  if (!after) return base;
  if (legacy) {
    if (!recordIdPattern.test(after)) throw new Error("invalid_record_id");
    return { ...base, after: { sortValue: after, id: after } };
  }
  return { ...base, after: decodeRecordCursor(after, base, collection) };
}

/* --------------------------------------------------------------- statement */

export interface RecordStatement {
  sql: string;
  params: unknown[];
}

/**
 * Builds the single statement one page costs.
 *
 * Shape (all identifiers static, all values bound):
 *
 *   SELECT id, data, created_at, updated_at FROM mb_records
 *    WHERE collection = ? [AND <col> <op> ?]… [AND (<sort>, id) > (?, ?)]
 *    ORDER BY <sort> ASC|DESC, id ASC|DESC LIMIT ?
 *
 * The row-value keyset comparison is what lets SQLite seek straight into the
 * composite `(collection, <sort>, id)` index instead of scanning; that is the
 * claim `src/query-index.test.ts` proves with EXPLAIN QUERY PLAN against real
 * SQLite. There is no OFFSET, and there is still exactly one D1 REST call.
 */
export function buildRecordStatement(collection: string, query: RecordQuery): RecordStatement {
  const sortSql = orderFields[query.orderField];
  const params: unknown[] = [collection];
  const conditions: string[] = ["collection = ?"];

  for (const filter of query.filters) {
    conditions.push(`${filterFields[filter.field].sql} ${operatorSql[filter.operator]} ?`);
    params.push(filter.value);
  }

  if (query.after) {
    const comparison = query.direction === "asc" ? ">" : "<";
    if (query.orderField === "id") {
      conditions.push(`id ${comparison} ?`);
      params.push(query.after.id);
    } else {
      conditions.push(`(${sortSql}, id) ${comparison} (?, ?)`);
      params.push(query.after.sortValue, query.after.id);
    }
  }

  const dir = query.direction === "asc" ? "ASC" : "DESC";
  const order = query.orderField === "id" ? `id ${dir}` : `${sortSql} ${dir}, id ${dir}`;
  params.push(query.limit + 1);

  return {
    // Columns are always the full row: field selection is applied to the
    // response, never to the cursor or to authorization.
    sql: `SELECT id, data, created_at, updated_at FROM mb_records WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?`,
    params,
  };
}

export interface StoredRecordRow {
  id: string;
  data: string;
  created_at: string;
  updated_at: string;
}

/** The value that continues `query`'s order after `row`. */
export function sortValueOf(query: RecordQuery, row: StoredRecordRow): string | number | null {
  if (query.orderField === "createdAt") return row.created_at;
  if (query.orderField === "updatedAt") return row.updated_at;
  return row.id;
}

/** Projects a stored row onto the selected response fields only. */
export function presentRecord(row: StoredRecordRow, select: SelectField[]): Record<string, unknown> {
  const presented: Record<string, unknown> = {};
  for (const field of select) {
    if (field === "id") presented.id = row.id;
    if (field === "data") presented.data = JSON.parse(row.data) as unknown;
    if (field === "createdAt") presented.createdAt = row.created_at;
    if (field === "updatedAt") presented.updatedAt = row.updated_at;
  }
  return presented;
}

/** Introspection for docs and SDK tests. */
export const recordQueryContract = {
  filters: Object.fromEntries(
    Object.entries(filterFields).map(([field, spec]) => [field, [...spec.operators]]),
  ) as Record<string, FilterOperator[]>,
  orders: Object.keys(orderFields),
  select: [...selectFields],
  directions: ["asc", "desc"] as const,
};
