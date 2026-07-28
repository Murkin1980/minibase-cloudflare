export interface MigrationFile {
  path: string;
  kind: "schema" | "table" | "auth-identities" | "storage-metadata" | "storage-object";
  format: "json" | "ndjson" | "sql" | "binary";
  sha256: string;
  bytes: number;
  rows?: number;
}

export interface MigrationManifest {
  formatVersion: 1;
  migrationId: string;
  source: { provider: "supabase"; projectRefSha256: string };
  target: { projectSlug: string };
  exportedAt: string;
  authStrategy: "password-reset" | "dual-auth-handoff";
  files: MigrationFile[];
}

const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const slugPattern = /^[a-z][a-z0-9-]{2,39}$/;
const pathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const kinds = new Set(["schema", "table", "auth-identities", "storage-metadata", "storage-object"]);
const formats = new Set(["json", "ndjson", "sql", "binary"]);

export function validateMigrationManifest(value: unknown): MigrationManifest {
  if (!value || typeof value !== "object") throw new Error("invalid_manifest");
  const manifest = value as Record<string, unknown>;
  if (manifest.formatVersion !== 1) throw new Error("unsupported_manifest_version");
  if (typeof manifest.migrationId !== "string" || !uuidPattern.test(manifest.migrationId)) {
    throw new Error("invalid_migration_id");
  }
  const source = manifest.source as Record<string, unknown> | undefined;
  if (source?.provider !== "supabase" || typeof source.projectRefSha256 !== "string" ||
      !hashPattern.test(source.projectRefSha256)) throw new Error("invalid_migration_source");
  const target = manifest.target as Record<string, unknown> | undefined;
  if (typeof target?.projectSlug !== "string" || !slugPattern.test(target.projectSlug)) {
    throw new Error("invalid_migration_target");
  }
  if (typeof manifest.exportedAt !== "string" || !Number.isFinite(Date.parse(manifest.exportedAt))) {
    throw new Error("invalid_exported_at");
  }
  if (manifest.authStrategy !== "password-reset" && manifest.authStrategy !== "dual-auth-handoff") {
    throw new Error("invalid_auth_strategy");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("invalid_manifest_files");
  const paths = new Set<string>();
  for (const fileValue of manifest.files) {
    if (!fileValue || typeof fileValue !== "object") throw new Error("invalid_manifest_file");
    const file = fileValue as Record<string, unknown>;
    if (typeof file.path !== "string" || !pathPattern.test(file.path) || file.path.includes("..") ||
        paths.has(file.path)) throw new Error("invalid_manifest_file_path");
    paths.add(file.path);
    if (!kinds.has(String(file.kind)) || !formats.has(String(file.format))) throw new Error("invalid_manifest_file_type");
    if (typeof file.sha256 !== "string" || !hashPattern.test(file.sha256)) throw new Error("invalid_manifest_checksum");
    if (!Number.isInteger(file.bytes) || (file.bytes as number) < 0) throw new Error("invalid_manifest_bytes");
    if (file.rows !== undefined && (!Number.isInteger(file.rows) || (file.rows as number) < 0)) {
      throw new Error("invalid_manifest_rows");
    }
  }
  return value as MigrationManifest;
}
