import { describe, expect, it } from "vitest";
import { pendingProjectSchemaVersions, projectSchemaMigrations } from "./project-schema";

describe("project schema lifecycle", () => {
  it("keeps migrations strictly ordered", () => {
    const versions = projectSchemaMigrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("plans only missing versions and is idempotent at current", () => {
    expect(pendingProjectSchemaVersions(0).map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(pendingProjectSchemaVersions(1).map((migration) => migration.version)).toEqual([2, 3]);
    expect(pendingProjectSchemaVersions(2).map((migration) => migration.version)).toEqual([3]);
    expect(pendingProjectSchemaVersions(3)).toEqual([]);
    expect(() => pendingProjectSchemaVersions(-1)).toThrow("invalid_schema_version");
  });

  it("contains no destructive schema statements", () => {
    const sql = projectSchemaMigrations.flatMap((migration) => migration.statements).join("\n");
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
  });
});
