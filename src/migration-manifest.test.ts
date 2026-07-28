import { describe, expect, it } from "vitest";
import { validateMigrationManifest } from "./migration-manifest";

const valid = {
  formatVersion: 1,
  migrationId: "123e4567-e89b-12d3-a456-426614174000",
  source: { provider: "supabase", projectRefSha256: "a".repeat(64) },
  target: { projectSlug: "tutor-kz" },
  exportedAt: "2026-07-29T00:00:00Z",
  authStrategy: "password-reset",
  files: [{
    path: "tables/lessons.ndjson", kind: "table", format: "ndjson",
    sha256: "b".repeat(64), bytes: 42, rows: 1,
  }],
} as const;

describe("migration manifest", () => {
  it("accepts the versioned checksum contract", () => {
    expect(validateMigrationManifest(valid).formatVersion).toBe(1);
  });
  it("rejects duplicate or traversing paths", () => {
    expect(() => validateMigrationManifest({ ...valid, files: [valid.files[0], valid.files[0]] }))
      .toThrow("invalid_manifest_file_path");
    expect(() => validateMigrationManifest({
      ...valid, files: [{ ...valid.files[0], path: "../secret" }],
    })).toThrow("invalid_manifest_file_path");
  });
  it("rejects password-hash copying as an auth strategy", () => {
    expect(() => validateMigrationManifest({ ...valid, authStrategy: "copy-password-hashes" }))
      .toThrow("invalid_auth_strategy");
  });
});
