import { describe, expect, it } from "vitest";
import type { MigrationManifest } from "./migration-manifest";
import { buildMigrationVerificationReport } from "./migration-verification";

const hash = "a".repeat(64);
const manifest: MigrationManifest = {
  formatVersion: 1,
  migrationId: "076448f0-5777-4cd6-8a20-c262a93c50d8",
  source: { provider: "supabase", projectRefSha256: "b".repeat(64) },
  target: { projectSlug: "one-c-tutor" },
  exportedAt: "2026-07-29T00:00:00.000Z",
  authStrategy: "password-reset",
  files: [{ path: "tables/profiles.ndjson", kind: "table", format: "ndjson", sha256: hash, bytes: 10, rows: 2 }],
};

describe("migration verification report", () => {
  it("passes only exact expected evidence", () => {
    const report = buildMigrationVerificationReport(
      manifest,
      [{ path: "tables/profiles.ndjson", sha256: hash, bytes: 10, rows: 2 }],
      "2026-07-29T01:00:00.000Z",
    );
    expect(report.status).toBe("passed");
    expect(report.checks[0].issues).toEqual([]);
  });

  it("reports missing, mismatched, unexpected, and duplicate evidence", () => {
    expect(buildMigrationVerificationReport(manifest, []).checks[0].status).toBe("missing");
    const report = buildMigrationVerificationReport(manifest, [
      { path: "tables/profiles.ndjson", sha256: "c".repeat(64), bytes: 11, rows: 3 },
      { path: "tables/extra.ndjson", sha256: hash, bytes: 0, rows: 0 },
    ]);
    expect(report.status).toBe("failed");
    expect(report.checks[0].issues).toEqual(["checksum", "bytes", "rows"]);
    expect(report.checks[1].issues).toEqual(["unexpected"]);
    expect(() => buildMigrationVerificationReport(manifest, [
      { path: "tables/profiles.ndjson", sha256: hash, bytes: 10, rows: 2 },
      { path: "tables/profiles.ndjson", sha256: hash, bytes: 10, rows: 2 },
    ])).toThrow("duplicate_verification_observation");
  });
});
