import type { MiniBaseLimits } from "./limits";

/**
 * Shared cursor-pagination contract for every list endpoint.
 *
 * MiniBase uses keyset pagination only. There is no `OFFSET`, because offset
 * scanning cost grows with depth and would make deep enumeration the cheapest
 * way to exhaust a project D1 quota.
 *
 * The cursor is opaque to MiniBase: each endpoint supplies its own validator
 * (record ID for records, safe path for files) so an untrusted cursor can never
 * reach SQL as anything but a bound parameter.
 */

export interface CursorQuery {
  limit: number;
  after?: string;
}

export interface Page<T> {
  items: T[];
  nextAfter: string | null;
  hasMore: boolean;
}

export function parseCursorQuery(
  url: URL,
  limits: MiniBaseLimits,
  validateCursor: (value: string) => string,
): CursorQuery {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? limits.defaultPageSize : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxPageSize) {
    throw new Error("invalid_limit");
  }
  const after = url.searchParams.get("after");
  if (after) validateCursor(after);
  return { limit, ...(after ? { after } : {}) };
}

/**
 * Turns a `limit + 1` fetch into a page plus an unambiguous "are we done" flag.
 *
 * The probe row is read and then discarded, so one extra row per page is the
 * whole cost of removing the ambiguity of "a non-null cursor on a short final
 * page". No second round trip is involved.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextAfter: last === undefined ? null : cursorOf(last),
    hasMore,
  };
}
