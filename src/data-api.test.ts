import { describe, expect, it } from "vitest";
import { parseListQuery, validateCollection, validateRecordData, validateRecordId } from "./data-api";
import { dataKeyRecordIsAuthorized } from "./data-auth";

describe("data-plane boundaries", () => {
  it("accepts only value-safe collection and record identifiers", () => {
    expect(validateCollection("lessons_2026")).toBe("lessons_2026");
    expect(validateRecordId("lesson:42")).toBe("lesson:42");
    expect(() => validateCollection("lessons; DROP TABLE x")).toThrow("invalid_collection");
    expect(() => validateRecordId("../secret")).toThrow("invalid_record_id");
  });

  it("accepts JSON objects and rejects scalar records", () => {
    expect(validateRecordData({ title: "Intro" })).toEqual({ title: "Intro" });
    expect(() => validateRecordData(["not", "an", "object"])).toThrow("invalid_record_data");
  });

  it("bounds record pagination", () => {
    expect(parseListQuery(new URL("https://minibase.test/v1/data/lessons?limit=25&after=a")))
      .toEqual({ limit: 25, after: "a" });
    expect(() => parseListQuery(new URL("https://minibase.test/v1/data/lessons?limit=1000"))).toThrow();
  });

  it("enforces project state, scope, expiry, and revocation", () => {
    const row = {
      id: "key",
      project_id: "project",
      kind: "publishable" as const,
      scopes: "data:read",
      expires_at: "2030-01-01T00:00:00Z",
      revoked_at: null,
      d1_database_id: "db",
      status: "active",
      last_used_at: null,
    };
    expect(dataKeyRecordIsAuthorized(row, "data:read", new Date("2029-01-01"))).toBe(true);
    expect(dataKeyRecordIsAuthorized(row, "data:write", new Date("2029-01-01"))).toBe(false);
    expect(dataKeyRecordIsAuthorized({ ...row, status: "suspended" }, "data:read", new Date("2029-01-01"))).toBe(false);
    expect(dataKeyRecordIsAuthorized({ ...row, revoked_at: "2028-01-01" }, "data:read", new Date("2029-01-01"))).toBe(false);
  });
});
