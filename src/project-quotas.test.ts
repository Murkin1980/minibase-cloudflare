import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, HARD_LIMITS, resolveLimits } from "./limits";
import {
  QUOTA_KEYS,
  parseProjectQuotas,
  resolveProjectLimits,
  resolveProjectQuota,
  type ProjectQuotaRow,
} from "./project-quotas";

/**
 * Builds a quota row. The parameters are typed `unknown` on purpose: the
 * fail-closed test below feeds this the garbage a hand-edited control row could
 * hold, and the resolver — not the type system — has to refuse it at runtime.
 */
function row(
  json: unknown = null,
  file: unknown = null,
  page: unknown = null,
  bulk: unknown = null,
): ProjectQuotaRow {
  return {
    quota_max_json_bytes: json,
    quota_max_file_bytes: file,
    quota_max_page_size: page,
    quota_max_bulk_records: bulk,
  } as ProjectQuotaRow;
}

describe("per-project quota resolution", () => {
  it("inherits the deployment ceilings when no quota is stored", () => {
    // This is the compatibility boundary: every project provisioned before
    // CP-03 holds NULL quotas and must be served exactly as it was.
    expect(resolveProjectLimits(DEFAULT_LIMITS, row())).toEqual(DEFAULT_LIMITS);
    expect(resolveProjectLimits(DEFAULT_LIMITS, null)).toEqual(DEFAULT_LIMITS);
    expect(resolveProjectLimits(DEFAULT_LIMITS, undefined)).toEqual(DEFAULT_LIMITS);
  });

  it("applies a stored quota that tightens the deployment ceiling", () => {
    expect(resolveProjectLimits(DEFAULT_LIMITS, row(8192, 1024, 25, 10))).toEqual({
      maxJsonBytes: 8192,
      maxFileBytes: 1024,
      maxPageSize: 25,
      maxBulkRecords: 10,
      defaultPageSize: 25,
      keyActivityIntervalMs: DEFAULT_LIMITS.keyActivityIntervalMs,
    });
  });

  it("never lets a project widen a deployment ceiling", () => {
    const tightened = resolveLimits({ MB_MAX_JSON_BYTES: "1024", MB_MAX_PAGE_SIZE: "10" });
    expect(resolveProjectQuota("maxJsonBytes", 65536, tightened)).toBe(1024);
    expect(resolveProjectQuota("maxPageSize", 500, tightened)).toBe(10);
    expect(resolveProjectLimits(tightened, row(65536, null, 500))).toMatchObject({
      maxJsonBytes: 1024,
      maxPageSize: 10,
      // The page default follows the project's page maximum, not the deployment's.
      defaultPageSize: 10,
    });
  });

  it("never lets a project exceed an absolute hard maximum", () => {
    const widened = resolveLimits({
      MB_MAX_JSON_BYTES: String(HARD_LIMITS.maxJsonBytes),
      MB_MAX_PAGE_SIZE: String(HARD_LIMITS.maxPageSize),
    });
    expect(resolveProjectQuota("maxJsonBytes", HARD_LIMITS.maxJsonBytes + 1, widened))
      .toBe(HARD_LIMITS.maxJsonBytes);
    expect(resolveProjectQuota("maxPageSize", HARD_LIMITS.maxPageSize + 1, widened))
      .toBe(HARD_LIMITS.maxPageSize);
  });

  it("fails closed on a malformed stored value", () => {
    // A row edited directly in the control D1 must never enlarge a request.
    for (const stored of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1024", {}, [], true]) {
      expect(resolveProjectQuota("maxJsonBytes", stored, DEFAULT_LIMITS), String(stored))
        .toBe(DEFAULT_LIMITS.maxJsonBytes);
    }
    expect(resolveProjectLimits(DEFAULT_LIMITS, row("99999", -5, 0, 1.5)))
      .toEqual(DEFAULT_LIMITS);
  });

  it("keeps the key-activity throttle out of a project's reach", () => {
    // It sizes a control-D1 write budget shared by every tenant, so a project
    // raising it would raise the whole deployment's write volume.
    expect(QUOTA_KEYS).not.toContain("keyActivityIntervalMs");
    const limits = resolveProjectLimits(
      resolveLimits({ MB_KEY_ACTIVITY_INTERVAL_MS: "60000" }),
      row(1024, 1024, 10, 10),
    );
    expect(limits.keyActivityIntervalMs).toBe(60000);
    expect(() => parseProjectQuotas({ keyActivityIntervalMs: 1 })).toThrowError("invalid_quota");
  });
});

describe("quota replacement input", () => {
  it("treats PUT as a full replacement, so an absent field clears that quota", () => {
    expect(parseProjectQuotas({ maxPageSize: 25 })).toEqual({
      maxJsonBytes: null,
      maxFileBytes: null,
      maxPageSize: 25,
      maxBulkRecords: null,
    });
    expect(parseProjectQuotas({})).toEqual({
      maxJsonBytes: null,
      maxFileBytes: null,
      maxPageSize: null,
      maxBulkRecords: null,
    });
    // An explicit null and an absent field mean the same thing, so a replay of
    // the same body is idempotent.
    expect(parseProjectQuotas({ maxJsonBytes: null })).toEqual(parseProjectQuotas({}));
  });

  it("rejects an unknown field rather than silently ignoring it", () => {
    // A misspelled quota must not look like it was applied.
    expect(() => parseProjectQuotas({ maxJsonBytes: 1024, maxRecords: 5 }))
      .toThrowError("invalid_quota");
    expect(() => parseProjectQuotas({ MAX_PAGE_SIZE: 5 })).toThrowError("invalid_quota");
  });

  it("rejects a value that is not a positive integer within the hard maximum", () => {
    for (const value of [0, -1, 1.5, "1024", {}, [], true]) {
      expect(() => parseProjectQuotas({ maxJsonBytes: value }), String(value))
        .toThrowError("invalid_quota");
    }
    expect(() => parseProjectQuotas({ maxJsonBytes: HARD_LIMITS.maxJsonBytes + 1 }))
      .toThrowError("invalid_quota");
    expect(() => parseProjectQuotas({ maxFileBytes: HARD_LIMITS.maxFileBytes + 1 }))
      .toThrowError("invalid_quota");
    // The hard maximum itself is accepted; the runtime clamp is what compares it
    // against the deployment ceiling.
    expect(parseProjectQuotas({ maxJsonBytes: HARD_LIMITS.maxJsonBytes }).maxJsonBytes)
      .toBe(HARD_LIMITS.maxJsonBytes);
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, undefined, 42, "quotas", [1]]) {
      expect(() => parseProjectQuotas(body), String(body)).toThrowError("body_must_be_object");
    }
  });
});
