import type { MigrationManifest } from "./migration-manifest";
import type { MigrationVerificationReport } from "./migration-verification";

export interface MigrationRollbackPlan {
  formatVersion: 1;
  migrationId: string;
  targetProjectSlug: string;
  d1Bookmark: string;
  r2BackupManifestPath: string;
  r2BackupManifestSha256: string;
  createdAt: string;
  steps: readonly [
    "disable-target-writes",
    "restore-d1-bookmark",
    "restore-r2-backup",
    "verify-source-manifest",
    "re-enable-target-writes",
  ];
}

const hashPattern = /^[a-f0-9]{64}$/;
const bookmarkPattern = /^[A-Za-z0-9._:-]{1,200}$/;
const safePathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

export function createMigrationRollbackPlan(input: {
  manifest: MigrationManifest;
  preflightReport: MigrationVerificationReport;
  d1Bookmark: string;
  r2BackupManifestPath: string;
  r2BackupManifestSha256: string;
  createdAt?: string;
}): MigrationRollbackPlan {
  const {
    manifest, preflightReport, d1Bookmark, r2BackupManifestPath, r2BackupManifestSha256,
  } = input;
  if (preflightReport.migrationId !== manifest.migrationId ||
      preflightReport.targetProjectSlug !== manifest.target.projectSlug ||
      preflightReport.status !== "passed") throw new Error("rollback_requires_verified_preflight");
  if (!bookmarkPattern.test(d1Bookmark)) throw new Error("invalid_d1_bookmark");
  if (!safePathPattern.test(r2BackupManifestPath) || r2BackupManifestPath.includes("..")) {
    throw new Error("invalid_r2_backup_manifest_path");
  }
  if (!hashPattern.test(r2BackupManifestSha256)) throw new Error("invalid_r2_backup_manifest_checksum");
  return {
    formatVersion: 1,
    migrationId: manifest.migrationId,
    targetProjectSlug: manifest.target.projectSlug,
    d1Bookmark,
    r2BackupManifestPath,
    r2BackupManifestSha256,
    createdAt: input.createdAt ?? new Date().toISOString(),
    steps: [
      "disable-target-writes",
      "restore-d1-bookmark",
      "restore-r2-backup",
      "verify-source-manifest",
      "re-enable-target-writes",
    ],
  };
}
