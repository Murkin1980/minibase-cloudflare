import { describe, expect, it } from "vitest";
import { buildPage, parseCursorQuery } from "./pagination";
import { DEFAULT_LIMITS } from "./limits";

const id = (value: string) => value;

describe("cursor pagination contract", () => {
  it("defaults the page size and bounds it by the configured maximum", () => {
    expect(parseCursorQuery(new URL("https://x/v1/data/c"), DEFAULT_LIMITS, id))
      .toEqual({ limit: 50 });
    expect(parseCursorQuery(new URL("https://x/v1/data/c?limit=100"), DEFAULT_LIMITS, id))
      .toEqual({ limit: 100 });
    expect(() => parseCursorQuery(new URL("https://x/v1/data/c?limit=101"), DEFAULT_LIMITS, id))
      .toThrow("invalid_limit");
    expect(() => parseCursorQuery(new URL("https://x/v1/data/c?limit=0"), DEFAULT_LIMITS, id))
      .toThrow("invalid_limit");
    expect(() => parseCursorQuery(new URL("https://x/v1/data/c?limit=1.5"), DEFAULT_LIMITS, id))
      .toThrow("invalid_limit");
  });

  it("honours a tightened maximum without touching the default", () => {
    const tight = { ...DEFAULT_LIMITS, maxPageSize: 10 };
    expect(() => parseCursorQuery(new URL("https://x/v1/data/c?limit=25"), tight, id))
      .toThrow("invalid_limit");
    expect(parseCursorQuery(new URL("https://x/v1/data/c?limit=10"), tight, id))
      .toEqual({ limit: 10 });
  });

  it("routes the cursor through the caller's own validator", () => {
    const rejecting = () => { throw new Error("invalid_record_id"); };
    expect(() => parseCursorQuery(new URL("https://x/v1/data/c?after=../x"), DEFAULT_LIMITS, rejecting))
      .toThrow("invalid_record_id");
  });

  it("reports hasMore only when a probe row was present", () => {
    // Full page with more rows behind it: limit + 1 rows came back.
    expect(buildPage(["a", "b", "c"], 2, id)).toEqual({
      items: ["a", "b"], nextAfter: "b", hasMore: true,
    });
    // Short final page: hasMore is false even though a cursor exists.
    expect(buildPage(["a", "b"], 5, id)).toEqual({
      items: ["a", "b"], nextAfter: "b", hasMore: false,
    });
    // Exactly a full page with nothing behind it is reported as the last page.
    expect(buildPage(["a", "b"], 2, id)).toEqual({
      items: ["a", "b"], nextAfter: "b", hasMore: false,
    });
    // Empty result terminates enumeration.
    expect(buildPage([], 5, id)).toEqual({ items: [], nextAfter: null, hasMore: false });
  });
});
