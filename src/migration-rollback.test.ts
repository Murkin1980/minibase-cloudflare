import { describe, expect, it } from "vitest";
import type { MigrationManifest } from "./migration-manifest";
import { createMigrationRollbackPlan } from "./migration-rollback";
import { buildMigrationVerificationReport } from "./migration-verification";

const checksum = "a".repeat(64);
const manifest: MigrationManifest = {
  formatVersion: 1,
  migrationId: "076448f0-5777-4cd6-8a20-c262a93c50d8",
  source: { provider: "supabase", projectRefSha256: "b".repeat(64) },
  target: { projectSlug: "one-c-tutor" },
  exportedAt: "2026-07-29T00:00:00.000Z",
  authStrategy: "dual-auth-handoff",
  files: [{ path: "tables/profiles.ndjson", kind: "table", format: "ndjson", sha256: checksum, bytes: 10, rows: 2 }],
};
const report = buildMigrationVerificationReport(
  manifest,
  [{ path: "tables/profiles.ndjson", sha256: checksum, bytes: 10, rows: 2 }],
);

describe("migration rollback plan", () => {
  it("binds verified evidence to ordered restoration steps", () => {
    const plan = createMigrationRollbackPlan({
      manifest,
      preflightReport: report,
      d1Bookmark: "bookmark-before-076448f0",
      r2BackupManifestPath: "backups/076448f0/r2-manifest.json",
      r2BackupManifestSha256: "c".repeat(64),
      createdAt: "2026-07-29T01:00:00.000Z",
    });
    expect(plan.steps[0]).toBe("disable-target-writes");
    expect(plan.steps.at(-1)).toBe("re-enable-target-writes");
  });

  it("rejects incomplete or mismatched recovery evidence", () => {
    expect(() => createMigrationRollbackPlan({
      manifest,
      preflightReport: { ...report, status: "failed" },
      d1Bookmark: "bookmark-before-076448f0",
      r2BackupManifestPath: "backups/r2-manifest.json",
      r2BackupManifestSha256: "c".repeat(64),
    })).toThrow("rollback_requires_verified_preflight");
    expect(() => createMigrationRollbackPlan({
      manifest,
      preflightReport: report,
      d1Bookmark: "",
      r2BackupManifestPath: "backups/r2-manifest.json",
      r2BackupManifestSha256: "c".repeat(64),
    })).toThrow("invalid_d1_bookmark");
  });
});
