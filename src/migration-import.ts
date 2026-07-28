import type { MigrationFile } from "./migration-manifest";
import {
  transformPostgresTable,
  transformPostgresValue,
  type PostgresTable,
} from "./postgres-sqlite";

export interface ImportStatement {
  sql: string;
  params: unknown[];
}

export interface TableImportBatch {
  migrationId: string;
  filePath: string;
  checksum: string;
  rowCount: number;
  statements: ImportStatement[];
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function quoteIdentifier(value: string): string {
  if (!identifierPattern.test(value)) throw new Error("unsafe_identifier");
  return `"${value}"`;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function verifyMigrationFile(file: MigrationFile, contents: Uint8Array): Promise<void> {
  if (contents.byteLength !== file.bytes) throw new Error("migration_file_size_mismatch");
  const digest = await crypto.subtle.digest("SHA-256", contents);
  if (bytesToHex(new Uint8Array(digest)) !== file.sha256) {
    throw new Error("migration_file_checksum_mismatch");
  }
}

export function parseNdjson(contents: Uint8Array): Record<string, unknown>[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    if (line.trim() === "") throw new Error(`invalid_ndjson_line:${index + 1}`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`invalid_ndjson_line:${index + 1}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid_ndjson_row:${index + 1}`);
    }
    return value as Record<string, unknown>;
  });
}

export async function buildTableImportBatch(input: {
  migrationId: string;
  file: MigrationFile;
  table: PostgresTable;
  contents: Uint8Array;
}): Promise<TableImportBatch> {
  const { migrationId, file, table, contents } = input;
  if (file.kind !== "table" || file.format !== "ndjson") throw new Error("unsupported_import_file");
  await verifyMigrationFile(file, contents);
  const rows = parseNdjson(contents);
  if (file.rows === undefined || rows.length !== file.rows) throw new Error("migration_file_row_count_mismatch");
  transformPostgresTable(table);

  const primaryKeys = table.columns.filter((column) => column.primaryKey);
  if (primaryKeys.length !== 1) throw new Error("table_requires_single_primary_key");
  const expected = new Set(table.columns.map((column) => column.name));
  const tableName = quoteIdentifier(table.name);
  const stagingName = quoteIdentifier(`mb_stage_${table.name}`);
  const columns = table.columns.map((column) => quoteIdentifier(column.name));
  const placeholders = columns.map(() => "?").join(", ");
  const statements: ImportStatement[] = [
    {
      sql: `CREATE TABLE IF NOT EXISTS ${stagingName} AS SELECT ${columns.join(", ")} FROM ${tableName} WHERE 0`,
      params: [],
    },
    { sql: `DELETE FROM ${stagingName}`, params: [] },
  ];

  for (const [index, row] of rows.entries()) {
    const keys = Object.keys(row);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      throw new Error(`migration_row_shape_mismatch:${index + 1}`);
    }
    const params = table.columns.map((column) => transformPostgresValue(column.type, row[column.name]));
    statements.push({
      sql: `INSERT INTO ${stagingName} (${columns.join(", ")}) VALUES (${placeholders})`,
      params,
    });
  }

  statements.push(
    {
      sql: `INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${stagingName}`,
      params: [],
    },
    {
      sql: `INSERT INTO mb_migration_imports
        (migration_id, file_path, checksum, row_count, imported_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(migration_id, file_path) DO UPDATE SET
          checksum = excluded.checksum,
          row_count = excluded.row_count,
          imported_at = excluded.imported_at`,
      params: [migrationId, file.path, file.sha256, rows.length],
    },
    { sql: `DROP TABLE ${stagingName}`, params: [] },
  );
  return {
    migrationId,
    filePath: file.path,
    checksum: file.sha256,
    rowCount: rows.length,
    statements,
  };
}

export function resolveImportReplay(
  existing: { checksum: string; rowCount: number } | null,
  batch: TableImportBatch,
): "execute" | "skip" {
  if (!existing) return "execute";
  if (existing.checksum !== batch.checksum || existing.rowCount !== batch.rowCount) {
    throw new Error("migration_import_conflict");
  }
  return "skip";
}
