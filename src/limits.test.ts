import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, HARD_LIMITS, resolveLimit, resolveLimits } from "./limits";

describe("configurable request limits", () => {
  it("keeps the historical defaults when nothing is configured", () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    // These three values are the compatibility boundary: changing them changes
    // what already-deployed consumers are allowed to send.
    expect(DEFAULT_LIMITS.maxJsonBytes).toBe(64 * 1024);
    expect(DEFAULT_LIMITS.maxFileBytes).toBe(25 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxPageSize).toBe(100);
  });

  it("applies a valid override", () => {
    expect(resolveLimits({
      MB_MAX_JSON_BYTES: "1024",
      MB_MAX_PAGE_SIZE: "20",
      MB_MAX_BULK_RECORDS: "10",
    })).toMatchObject({ maxJsonBytes: 1024, maxPageSize: 20, maxBulkRecords: 10 });
  });

  it("ignores an override that would widen a ceiling beyond its hard maximum", () => {
    expect(resolveLimit("maxJsonBytes", { MB_MAX_JSON_BYTES: "999999999" }))
      .toBe(DEFAULT_LIMITS.maxJsonBytes);
    expect(resolveLimit("maxPageSize", { MB_MAX_PAGE_SIZE: String(HARD_LIMITS.maxPageSize + 1) }))
      .toBe(DEFAULT_LIMITS.maxPageSize);
    expect(resolveLimits({ MB_MAX_PAGE_SIZE: "100000" }).maxFileBytes)
      .toBe(DEFAULT_LIMITS.maxFileBytes);
  });

  it("ignores malformed, fractional, zero, and negative overrides", () => {
    for (const value of ["", "abc", "1.5", "0", "-1", "1e9", "NaN"]) {
      expect(resolveLimit("maxJsonBytes", { MB_MAX_JSON_BYTES: value }))
        .toBe(DEFAULT_LIMITS.maxJsonBytes);
    }
  });

  it("never lets the page default exceed the page maximum", () => {
    expect(resolveLimits({ MB_MAX_PAGE_SIZE: "10" }).defaultPageSize).toBe(10);
    expect(resolveLimits({ MB_MAX_PAGE_SIZE: "400" }).defaultPageSize).toBe(50);
  });
});
