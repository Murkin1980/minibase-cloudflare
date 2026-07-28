import { describe, expect, it } from "vitest";
import { mapPostgresType, transformPostgresTable, transformPostgresValue } from "./postgres-sqlite";

describe("PostgreSQL to SQLite transform", () => {
  it("maps common Supabase/Postgres types deterministically", () => {
    expect(mapPostgresType("uuid").sqlite).toBe("TEXT");
    expect(mapPostgresType("jsonb").sqlite).toContain("TEXT");
    expect(mapPostgresType("boolean").sqlite).toContain("INTEGER");
    expect(mapPostgresType("numeric(20,4)").warning).toContain("precision");
    expect(() => mapPostgresType("tsvector")).toThrow("unsupported_postgres_type");
  });

  it("generates quoted SQLite DDL and reports omitted defaults", () => {
    const result = transformPostgresTable({
      schema: "public",
      name: "lessons",
      columns: [
        { name: "id", type: "uuid", nullable: false, primaryKey: true },
        { name: "published", type: "boolean", nullable: false, default: "false" },
        { name: "payload", type: "jsonb", nullable: false },
        { name: "owner_id", type: "uuid", nullable: false, default: "auth.uid()" },
      ],
    });
    expect(result.sql).toContain('CREATE TABLE "lessons"');
    expect(result.sql).toContain('CHECK ("published" IN (0, 1))');
    expect(result.sql).toContain('CHECK (json_valid("payload"))');
    expect(result.warnings).toContain("owner_id: default auth.uid() omitted");
    expect(() => transformPostgresTable({ schema: "public", name: "x;drop", columns: [] })).toThrow();
  });

  it("transforms exported row values without evaluating them", () => {
    expect(transformPostgresValue("boolean", true)).toBe(1);
    expect(transformPostgresValue("jsonb", { ok: true })).toBe('{"ok":true}');
    expect([...transformPostgresValue("bytea", "\\x00ff") as Uint8Array]).toEqual([0, 255]);
    expect(transformPostgresValue("text[]", ["a", "b"])).toBe('["a","b"]');
  });
});
