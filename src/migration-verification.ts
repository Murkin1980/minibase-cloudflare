import type { MigrationManifest } from "./migration-manifest";

export interface ImportedFileObservation {
  path: string;
  sha256: string;
  bytes: number;
  rows?: number;
}

export interface VerificationCheck {
  path: string;
  status: "passed" | "failed" | "missing";
  issues: string[];
}

export interface MigrationVerificationReport {
  migrationId: string;
  targetProjectSlug: string;
  verifiedAt: string;
  status: "passed" | "failed";
  checks: VerificationCheck[];
}

export function buildMigrationVerificationReport(
  manifest: MigrationManifest,
  observations: ImportedFileObservation[],
  verifiedAt = new Date().toISOString(),
): MigrationVerificationReport {
  const byPath = new Map<string, ImportedFileObservation>();
  for (const observation of observations) {
    if (byPath.has(observation.path)) throw new Error("duplicate_verification_observation");
    byPath.set(observation.path, observation);
  }
  const checks = manifest.files.map((expected): VerificationCheck => {
    const actual = byPath.get(expected.path);
    if (!actual) return { path: expected.path, status: "missing", issues: ["missing"] };
    const issues: string[] = [];
    if (actual.sha256 !== expected.sha256) issues.push("checksum");
    if (actual.bytes !== expected.bytes) issues.push("bytes");
    if (expected.rows !== undefined && actual.rows !== expected.rows) issues.push("rows");
    return {
      path: expected.path,
      status: issues.length === 0 ? "passed" : "failed",
      issues,
    };
  });
  const unexpected = observations
    .filter((observation) => !manifest.files.some((file) => file.path === observation.path))
    .map((observation): VerificationCheck => ({
      path: observation.path,
      status: "failed",
      issues: ["unexpected"],
    }));
  checks.push(...unexpected);
  return {
    migrationId: manifest.migrationId,
    targetProjectSlug: manifest.target.projectSlug,
    verifiedAt,
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks,
  };
}
