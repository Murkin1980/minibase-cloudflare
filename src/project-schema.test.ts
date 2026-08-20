import { describe, expect, it } from "vitest";
import { pendingProjectSchemaVersions, projectSchemaMigrations } from "./project-schema";

describe("project schema lifecycle", () => {
  it("keeps migrations strictly ordered", () => {
    const versions = projectSchemaMigrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("plans only missing versions and is idempotent at current", () => {
    expect(pendingProjectSchemaVersions(0).map((migration) => migration.version)).toEqual([1, 2, 3, 4]);
    expect(pendingProjectSchemaVersions(1).map((migration) => migration.version)).toEqual([2, 3, 4]);
    expect(pendingProjectSchemaVersions(2).map((migration) => migration.version)).toEqual([3, 4]);
    expect(pendingProjectSchemaVersions(3).map((migration) => migration.version)).toEqual([4]);
    expect(pendingProjectSchemaVersions(4)).toEqual([]);
    expect(() => pendingProjectSchemaVersions(-1)).toThrow("invalid_schema_version");
  });

  it("contains no destructive schema statements", () => {
    const sql = projectSchemaMigrations.flatMap((migration) => migration.statements).join("\n");
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
  });

  it("defines hash-only user sessions and authoritative memberships", () => {
    const sql = projectSchemaMigrations.find((migration) => migration.version === 4)?.statements.join("\n") ?? "";
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mb_users");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mb_sessions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mb_activation_tokens");
    expect(sql).toContain("token_hash TEXT NOT NULL UNIQUE");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mb_organization_memberships");
    expect(sql).toContain("PRIMARY KEY (organization_id, user_id)");
    expect(sql).not.toMatch(/password_hash|refresh_token|access_token|jwt_secret|source_provider|source_user_id/i);
  });
});
