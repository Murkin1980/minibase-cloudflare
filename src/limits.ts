/**
 * Single source of truth for every bounded value MiniBase accepts.
 *
 * Every ceiling here exists to keep one project from exhausting a shared
 * Cloudflare free-tier quota. Defaults reproduce the values that were hard
 * coded before this module existed, so existing consumers are unaffected.
 *
 * An operator may tighten (or moderately raise) a ceiling through Worker
 * `[vars]`. An override that is not a positive integer within its absolute
 * ceiling is ignored and the default is kept: a misconfigured variable must
 * never widen an unbounded request.
 */

export interface MiniBaseLimits {
  maxJsonBytes: number;
  maxFileBytes: number;
  defaultPageSize: number;
  maxPageSize: number;
  maxBulkRecords: number;
  /**
   * Minimum gap between two `last_used_at` writes for the same key.
   *
   * Every authenticated request used to write one row to the control D1. Since
   * 2026-09-01 the D1 free tier hard-fails past its daily row-write limit, so
   * that write was a ceiling on total MiniBase traffic, shared by every project.
   * Throttling it turns one write per request into one write per key per
   * interval without weakening revocation or expiry, which are still checked on
   * every single request.
   */
  keyActivityIntervalMs: number;
}

/** Absolute ceilings. An override may never exceed these. */
export const HARD_LIMITS = {
  maxJsonBytes: 1024 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  maxPageSize: 500,
  maxBulkRecords: 1000,
  keyActivityIntervalMs: 60 * 60 * 1000,
} as const;

export const DEFAULT_LIMITS: MiniBaseLimits = {
  maxJsonBytes: 64 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  defaultPageSize: 50,
  maxPageSize: 100,
  maxBulkRecords: 500,
  keyActivityIntervalMs: 5 * 60 * 1000,
};

/** Optional Worker `[vars]` that override the defaults. */
export interface LimitOverrides {
  MB_MAX_JSON_BYTES?: string;
  MB_MAX_FILE_BYTES?: string;
  MB_MAX_PAGE_SIZE?: string;
  MB_MAX_BULK_RECORDS?: string;
  MB_KEY_ACTIVITY_INTERVAL_MS?: string;
}

const overrideKeys = {
  maxJsonBytes: "MB_MAX_JSON_BYTES",
  maxFileBytes: "MB_MAX_FILE_BYTES",
  maxPageSize: "MB_MAX_PAGE_SIZE",
  maxBulkRecords: "MB_MAX_BULK_RECORDS",
  keyActivityIntervalMs: "MB_KEY_ACTIVITY_INTERVAL_MS",
} as const;

type OverridableKey = keyof typeof overrideKeys;

/**
 * Resolves one ceiling: a usable override wins, anything else falls back.
 * Exported so the behaviour is directly testable.
 */
export function resolveLimit(
  key: OverridableKey,
  overrides: LimitOverrides = {},
): number {
  const raw = overrides[overrideKeys[key]];
  if (raw === undefined || raw === "") return DEFAULT_LIMITS[key];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > HARD_LIMITS[key]) {
    return DEFAULT_LIMITS[key];
  }
  return parsed;
}

export function resolveLimits(overrides: LimitOverrides = {}): MiniBaseLimits {
  const maxPageSize = resolveLimit("maxPageSize", overrides);
  return {
    maxJsonBytes: resolveLimit("maxJsonBytes", overrides),
    maxFileBytes: resolveLimit("maxFileBytes", overrides),
    maxPageSize,
    maxBulkRecords: resolveLimit("maxBulkRecords", overrides),
    keyActivityIntervalMs: resolveLimit("keyActivityIntervalMs", overrides),
    // A page default can never exceed the page maximum it belongs to.
    defaultPageSize: Math.min(DEFAULT_LIMITS.defaultPageSize, maxPageSize),
  };
}
