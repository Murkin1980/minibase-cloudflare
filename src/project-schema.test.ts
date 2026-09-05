import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProjectSchema,
  inspectProjectSchema,
  latestKnownProjectSchemaVersion,
  pendingProjectSchemaVersions,
  projectSchemaMigrations,
  verifyProjectSchema,
} from "./project-schema";
import { createHarness, type Harness } from "./test-harness";

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
  vi.restoreAllMocks();
});

describe("project schema migrations contract", () => {
  it("keeps migrations strictly ordered and contiguous", () => {
    const versions = projectSchemaMigrations.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((left, right) => left - right));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(latestKnownProjectSchemaVersion).toBe(5);
  });

  it("plans only missing versions and is idempotent at current", () => {
    expect(pendingProjectSchemaVersions(0).map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5]);
    expect(pendingProjectSchemaVersions(1).map((migration) => migration.version)).toEqual([2, 3, 4, 5]);
    expect(pendingProjectSchemaVersions(2).map((migration) => migration.version)).toEqual([3, 4, 5]);
    expect(pendingProjectSchemaVersions(3).map((migration) => migration.version)).toEqual([4, 5]);
    expect(pendingProjectSchemaVersions(4).map((migration) => migration.version)).toEqual([5]);
    expect(pendingProjectSchemaVersions(5)).toEqual([]);
    expect(() => pendingProjectSchemaVersions(-1)).toThrow("invalid_schema_version");
  });

  it("contains no destructive schema statements", () => {
    const sql = projectSchemaMigrations.flatMap((migration) => migration.statements).join("\n");
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
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

describe("project schema inspection (project DB authoritative)", () => {
  it("inspects clean project on the latest version", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-1",
        databaseId: "db-1",
        slug: "clean-project",
        dataSchemaVersion: 5,
        schemaVersions: [1, 2, 3, 4, 5],
      }],
    });
    const state = await inspectProjectSchema(harness.env, "db-1");
    expect(state).toEqual({
      authoritativeVersion: 5,
      appliedVersions: [1, 2, 3, 4, 5],
      hasVersionTable: true,
      issues: [],
    });
  });

  it("inspects project on an older version", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-old",
        databaseId: "db-old",
        slug: "old-project",
        dataSchemaVersion: 2,
        schemaVersions: [1, 2],
      }],
    });
    const state = await inspectProjectSchema(harness.env, "db-old");
    expect(state).toEqual({
      authoritativeVersion: 2,
      appliedVersions: [1, 2],
      hasVersionTable: true,
      issues: [],
    });
  });

  it("detects missing mb_schema_versions table on clean/unmigrated DB", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-empty",
        databaseId: "db-empty",
        slug: "empty-project",
        dataSchemaVersion: 0,
        schemaVersions: [],
        hasSchemaVersionsTable: false,
      }],
    });
    const state = await inspectProjectSchema(harness.env, "db-empty");
    expect(state).toEqual({
      authoritativeVersion: 0,
      appliedVersions: [],
      hasVersionTable: false,
      issues: [],
    });
  });

  it("detects gaps in applied versions (missing intermediate version)", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-gap",
        databaseId: "db-gap",
        slug: "gap-project",
        dataSchemaVersion: 3,
        schemaVersions: [1, 3],
      }],
    });
    const state = await inspectProjectSchema(harness.env, "db-gap");
    expect(state.issues).toContain("missing_version_gap");
    expect(state.appliedVersions).toEqual([1, 3]);
  });

  it("detects future or unknown versions", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-future",
        databaseId: "db-future",
        slug: "future-project",
        dataSchemaVersion: 6,
        schemaVersions: [1, 2, 3, 4, 5, 6],
      }],
    });
    const state = await inspectProjectSchema(harness.env, "db-future");
    expect(state.issues).toContain("unknown_future_version");
    expect(state.appliedVersions).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("project schema verification (mismatch detection)", () => {
  it("verifies clean project matches expected version", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-1",
        databaseId: "db-1",
        slug: "clean-project",
        dataSchemaVersion: 5,
        schemaVersions: [1, 2, 3, 4, 5],
      }],
    });
    const verification = await verifyProjectSchema(harness.env, "proj-1");
    expect(verification).toEqual({
      projectId: "proj-1",
      status: "ok",
      authoritativeVersion: 5,
      cachedVersion: 5,
      latestKnownVersion: 5,
      appliedVersions: [1, 2, 3, 4, 5],
      pendingVersions: [],
      issues: [],
    });
  });

  it("verifies older project with pending migrations", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-2",
        databaseId: "db-2",
        slug: "v2-project",
        dataSchemaVersion: 2,
        schemaVersions: [1, 2],
      }],
    });
    const verification = await verifyProjectSchema(harness.env, "proj-2");
    expect(verification).toEqual({
      projectId: "proj-2",
      status: "ok",
      authoritativeVersion: 2,
      cachedVersion: 2,
      latestKnownVersion: 5,
      appliedVersions: [1, 2],
      pendingVersions: [3, 4, 5],
      issues: [],
    });
  });

  it("detects control metadata mismatch when control DB is behind project DB", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-ctrl-behind",
        databaseId: "db-ctrl-behind",
        slug: "behind-project",
        dataSchemaVersion: 1, // Control DB is behind
        schemaVersions: [1, 2, 3, 4, 5], // Project DB has all versions
      }],
    });
    const verification = await verifyProjectSchema(harness.env, "proj-ctrl-behind");
    expect(verification.status).toBe("drift_detected");
    expect(verification.authoritativeVersion).toBe(5);
    expect(verification.cachedVersion).toBe(1);
    expect(verification.issues).toContain("control_version_mismatch");
    expect(verification.pendingVersions).toEqual([]);
  });

  it("detects control metadata mismatch when control DB is ahead of project DB", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-ctrl-ahead",
        databaseId: "db-ctrl-ahead",
        slug: "ahead-project",
        dataSchemaVersion: 4, // Control DB claims 4
        schemaVersions: [1, 2], // Project DB only has 2
      }],
    });
    const verification = await verifyProjectSchema(harness.env, "proj-ctrl-ahead");
    expect(verification.status).toBe("drift_detected");
    expect(verification.authoritativeVersion).toBe(2);
    expect(verification.cachedVersion).toBe(4);
    expect(verification.issues).toContain("control_version_mismatch");
    expect(verification.pendingVersions).toEqual([3, 4, 5]);
  });

  it("detects missing version table when control DB expected version > 0", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-missing-tbl",
        databaseId: "db-missing-tbl",
        slug: "missing-tbl-project",
        dataSchemaVersion: 3,
        schemaVersions: [],
        hasSchemaVersionsTable: false,
      }],
    });
    const verification = await verifyProjectSchema(harness.env, "proj-missing-tbl");
    expect(verification.status).toBe("inconsistent");
    expect(verification.authoritativeVersion).toBe(0);
    expect(verification.cachedVersion).toBe(3);
    expect(verification.issues).toContain("missing_schema_versions_table");
    expect(verification.issues).toContain("control_version_mismatch");
    expect(verification.pendingVersions).toEqual([]);
  });

  it("marks state inconsistent when gaps exist in project DB", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-gap",
        databaseId: "db-gap",
        slug: "gap-project",
        dataSchemaVersion: 3,
        schemaVersions: [1, 3],
      }],
    });
    const verification = await verifyProjectSchema(harness.env, "proj-gap");
    expect(verification.status).toBe("inconsistent");
    expect(verification.issues).toContain("missing_version_gap");
    expect(verification.pendingVersions).toEqual([]);
  });

  it("marks state inconsistent when future unknown version exists in project DB", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-fut",
        databaseId: "db-fut",
        slug: "fut-project",
        dataSchemaVersion: 6,
        schemaVersions: [1, 2, 3, 4, 5, 6],
      }],
    });
    const verification = await verifyProjectSchema(harness.env, "proj-fut");
    expect(verification.status).toBe("inconsistent");
    expect(verification.issues).toContain("unknown_future_version");
    expect(verification.pendingVersions).toEqual([]);
  });

  it("throws for unknown project ID", async () => {
    harness = createHarness({ projects: [] });
    await expect(verifyProjectSchema(harness.env, "non-existent")).rejects.toThrow("project_not_found");
  });
});

describe("project schema application", () => {
  it("is a no-op and idempotent on a clean project at latest version", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-1",
        databaseId: "db-1",
        slug: "clean-project",
        dataSchemaVersion: 5,
        schemaVersions: [1, 2, 3, 4, 5],
      }],
    });
    const result = await applyProjectSchema(harness.env, "proj-1", "mgmt-key-1");
    expect(result).toEqual({ previousVersion: 5, version: 5, applied: [] });
    // No DDL queries executed on project DB
    const ddlCalls = harness.d1Calls.filter((c) => c.sql.startsWith("CREATE TABLE") || c.sql.startsWith("INSERT"));
    expect(ddlCalls).toHaveLength(0);
  });

  it("applies pending migrations to an older project (v2 -> v4)", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-2",
        databaseId: "db-2",
        slug: "v2-project",
        dataSchemaVersion: 2,
        schemaVersions: [1, 2],
      }],
    });
    const result = await applyProjectSchema(harness.env, "proj-2", "mgmt-key-1", "req-corr-1");
    expect(result).toEqual({ previousVersion: 2, version: 5, applied: [3, 4, 5] });

    // Project DB schema versions updated
    expect(harness.schemaStore.get("db-2")?.versions).toEqual([1, 2, 3, 4, 5]);
    // Control DB cached version updated
    expect(harness.projectRows.get("proj-2")?.data_schema_version).toBe(5);

    // Audit log records action with correlation ID
    expect(harness.audit).toHaveLength(1);
    const [, projectId, action, , actorKeyId, outcome, metadata, entity, entityId, correlationId] =
      harness.audit[0].values as unknown[];
    expect(action).toBe("project.schema_applied");
    expect(outcome).toBe("success");
    expect(entity).toBe("project");
    expect(entityId).toBe("proj-2");
    expect(projectId).toBe("proj-2");
    expect(actorKeyId).toBe("mgmt-key-1");
    expect(correlationId).toBe("req-corr-1");
    expect(JSON.parse(String(metadata))).toEqual({ previousVersion: 2, version: 5, applied: [3, 4, 5] });
  });

  it("is safe and idempotent on repeated schema apply", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-rep",
        databaseId: "db-rep",
        slug: "rep-project",
        dataSchemaVersion: 2,
        schemaVersions: [1, 2],
      }],
    });
    const first = await applyProjectSchema(harness.env, "proj-rep", "mgmt-key-1");
    expect(first).toEqual({ previousVersion: 2, version: 5, applied: [3, 4, 5] });

    const second = await applyProjectSchema(harness.env, "proj-rep", "mgmt-key-1");
    expect(second).toEqual({ previousVersion: 5, version: 5, applied: [] });
    expect(harness.schemaStore.get("db-rep")?.versions).toEqual([1, 2, 3, 4, 5]);
    expect(harness.projectRows.get("proj-rep")?.data_schema_version).toBe(5);
  });

  it("synchronizes control DB cache when control DB was behind project DB", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-behind",
        databaseId: "db-behind",
        slug: "behind-project",
        dataSchemaVersion: 1, // Control DB was behind
        schemaVersions: [1, 2, 3, 4, 5], // Project DB already had all migrations
      }],
    });
    const result = await applyProjectSchema(harness.env, "proj-behind", "mgmt-key-1");
    expect(result).toEqual({ previousVersion: 5, version: 5, applied: [] });
    expect(harness.projectRows.get("proj-behind")?.data_schema_version).toBe(5);
  });

  it("applies missing migrations when control DB was ahead of project DB", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-ahead",
        databaseId: "db-ahead",
        slug: "ahead-project",
        dataSchemaVersion: 4, // Control DB prematurely claimed 4
        schemaVersions: [1, 2], // Project DB actually only had 2
      }],
    });
    // Authority is project DB, so migrations 3 and 4 are applied
    const result = await applyProjectSchema(harness.env, "proj-ahead", "mgmt-key-1");
    expect(result).toEqual({ previousVersion: 2, version: 5, applied: [3, 4, 5] });
    expect(harness.schemaStore.get("db-ahead")?.versions).toEqual([1, 2, 3, 4, 5]);
    expect(harness.projectRows.get("proj-ahead")?.data_schema_version).toBe(5);
  });

  it("applies all migrations to an unmigrated clean project without schema table (cached version 0)", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-clean",
        databaseId: "db-clean",
        slug: "clean-project",
        dataSchemaVersion: 0,
        schemaVersions: [],
        hasSchemaVersionsTable: false,
      }],
    });
    const result = await applyProjectSchema(harness.env, "proj-clean", "mgmt-key-1");
    expect(result).toEqual({ previousVersion: 0, version: 5, applied: [1, 2, 3, 4, 5] });
    expect(harness.schemaStore.get("db-clean")?.versions).toEqual([1, 2, 3, 4, 5]);
    expect(harness.schemaStore.get("db-clean")?.hasTable).toBe(true);
    expect(harness.projectRows.get("proj-clean")?.data_schema_version).toBe(5);
  });

  it("refuses to apply schema when version table is missing but control DB version > 0 (fail-safe)", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-missing-tbl-ctrl-active",
        databaseId: "db-missing-tbl-ctrl-active",
        slug: "missing-tbl-active-project",
        dataSchemaVersion: 3,
        schemaVersions: [],
        hasSchemaVersionsTable: false,
      }],
    });
    await expect(applyProjectSchema(harness.env, "proj-missing-tbl-ctrl-active", "mgmt-key-1"))
      .rejects.toThrow("inconsistent_schema_state");
    expect(harness.projectRows.get("proj-missing-tbl-ctrl-active")?.data_schema_version).toBe(3);
    expect(harness.d1Calls.filter((c) => c.sql.startsWith("CREATE TABLE"))).toHaveLength(0);
  });

  it("refuses to apply schema on inconsistent gap state (fail-safe)", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-gap",
        databaseId: "db-gap",
        slug: "gap-project",
        dataSchemaVersion: 3,
        schemaVersions: [1, 3],
      }],
    });
    await expect(applyProjectSchema(harness.env, "proj-gap", "mgmt-key-1"))
      .rejects.toThrow("inconsistent_schema_state");
  });

  it("refuses to apply schema on unknown future version state (fail-safe)", async () => {
    harness = createHarness({
      projects: [{
        projectId: "proj-fut",
        databaseId: "db-fut",
        slug: "fut-project",
        dataSchemaVersion: 6,
        schemaVersions: [1, 2, 3, 4, 5, 6],
      }],
    });
    await expect(applyProjectSchema(harness.env, "proj-fut", "mgmt-key-1"))
      .rejects.toThrow("inconsistent_schema_state");
  });
});
