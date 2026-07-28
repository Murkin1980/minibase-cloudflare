import { describe, expect, it } from "vitest";
import { buildTableImportBatch, parseNdjson, resolveImportReplay } from "./migration-import";

const encoder = new TextEncoder();
const contents = encoder.encode(
  '{"id":"a","active":true,"settings":{"theme":"dark"}}\n' +
  '{"id":"b","active":false,"settings":[]}\n',
);
const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", contents));
const checksum = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
const file = {
  path: "tables/profiles.ndjson",
  kind: "table" as const,
  format: "ndjson" as const,
  sha256: checksum,
  bytes: contents.byteLength,
  rows: 2,
};
const table = {
  schema: "public",
  name: "profiles",
  columns: [
    { name: "id", type: "uuid", nullable: false, primaryKey: true },
    { name: "active", type: "boolean", nullable: false },
    { name: "settings", type: "jsonb", nullable: false },
  ],
};

describe("migration table import", () => {
  it("verifies and creates deterministic staging batch", async () => {
    const batch = await buildTableImportBatch({
      migrationId: "076448f0-5777-4cd6-8a20-c262a93c50d8",
      file,
      table,
      contents,
    });
    expect(batch.rowCount).toBe(2);
    expect(batch.statements).toHaveLength(7);
    expect(batch.statements[2].params).toEqual(["a", 1, '{"theme":"dark"}']);
    expect(batch.statements[3].params).toEqual(["b", 0, "[]"]);
    expect(resolveImportReplay(null, batch)).toBe("execute");
    expect(resolveImportReplay({ checksum: file.sha256, rowCount: 2 }, batch)).toBe("skip");
  });

  it("rejects checksum, row count, shape, and replay conflicts", async () => {
    await expect(buildTableImportBatch({
      migrationId: "076448f0-5777-4cd6-8a20-c262a93c50d8",
      file: { ...file, sha256: "0".repeat(64) },
      table,
      contents,
    })).rejects.toThrow("migration_file_checksum_mismatch");
    await expect(buildTableImportBatch({
      migrationId: "076448f0-5777-4cd6-8a20-c262a93c50d8",
      file: { ...file, rows: 3 },
      table,
      contents,
    })).rejects.toThrow("migration_file_row_count_mismatch");
    const badShape = encoder.encode('{"id":"a","active":true}\n');
    const badDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", badShape));
    const badChecksum = [...badDigest].map((value) => value.toString(16).padStart(2, "0")).join("");
    await expect(buildTableImportBatch({
      migrationId: "076448f0-5777-4cd6-8a20-c262a93c50d8",
      file: {
        ...file,
        bytes: badShape.byteLength,
        rows: 1,
        sha256: badChecksum,
      },
      table,
      contents: badShape,
    })).rejects.toThrow("migration_row_shape_mismatch:1");
    const batch = await buildTableImportBatch({
      migrationId: "076448f0-5777-4cd6-8a20-c262a93c50d8",
      file,
      table,
      contents,
    });
    expect(() => resolveImportReplay({ checksum: "f".repeat(64), rowCount: 2 }, batch))
      .toThrow("migration_import_conflict");
  });

  it("reports exact malformed NDJSON line", () => {
    expect(() => parseNdjson(encoder.encode('{"id":1}\nnope\n'))).toThrow("invalid_ndjson_line:2");
  });
});
