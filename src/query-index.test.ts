import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { buildRecordStatement, parseRecordQuery } from "./record-query";
import { DEFAULT_LIMITS } from "./limits";
import { projectSchemaMigrations } from "./project-schema";

/**
 * CP-04 index proof, against real SQLite.
 *
 * The harness in `src/test-harness.ts` models MiniBase's SQL; it cannot say
 * anything about the query planner. These tests run the exact statement
 * `buildRecordStatement` emits through a real D1 (Miniflare) with the real
 * project schema applied, and assert on `EXPLAIN QUERY PLAN` output — that the
 * planner picks the intended index, and, just as importantly, that it does not
 * fall back to a full scan of `mb_records`.
 *
 * A supported hot path without a named index here is a supported hot path that
 * will silently scan a tenant's collection in production.
 */

let mf: Miniflare;
let db: D1Database;

type D1Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

const query = (search: string) =>
  parseRecordQuery(new URL(`https://minibase.test/v1/data/lessons${search}`), DEFAULT_LIMITS, "lessons");

async function plan(search: string): Promise<string> {
  const statement = buildRecordStatement("lessons", query(search));
  const explained = await db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .bind(...statement.params as never[]).all();
  return (explained.results as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-07-28",
    d1Databases: { PROJECT_DB: "cp04-query-index" },
    cf: false,
  });
  db = await mf.getD1Database("PROJECT_DB");
  for (const migration of projectSchemaMigrations) {
    for (const sql of migration.statements) await db.prepare(sql).run();
  }
  // Enough rows, and enough duplicate timestamps, that the planner has a real
  // choice to make rather than trivially preferring a scan of a tiny table.
  const rows = [];
  for (let index = 0; index < 400; index += 1) {
    const stamp = `2026-09-0${1 + (index % 5)}T00:00:0${index % 10}.000Z`;
    rows.push(db.prepare(
      "INSERT INTO mb_records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      index % 3 === 0 ? "notes" : "lessons",
      `rec-${String(index).padStart(4, "0")}`,
      JSON.stringify({ schemaVersion: index % 4, text: "x" }),
      stamp,
      stamp,
    ));
  }
  await db.batch(rows);
  await db.prepare("ANALYZE").run();
});

afterAll(async () => {
  await mf.dispose();
});

describe("CP-04 EXPLAIN QUERY PLAN for every supported hot path", () => {
  it("keeps the legacy id listing on the primary key", async () => {
    const detail = await plan("?limit=10");
    expect(detail).toMatch(/SEARCH mb_records USING (PRIMARY KEY|INDEX sqlite_autoindex_mb_records_1)/);
    expect(detail).toContain("collection=?");
  });

  it("uses the primary key for a paged legacy listing", async () => {
    const detail = await plan("?limit=10&after=rec-0100");
    expect(detail).toMatch(/SEARCH mb_records USING (PRIMARY KEY|INDEX sqlite_autoindex_mb_records_1)/);
  });

  it("uses the created_at index for createdAt ordering", async () => {
    const detail = await plan("?order=createdAt.asc&limit=10");
    expect(detail).toContain("mb_records_collection_created_id_idx");
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("uses the created_at index for descending createdAt ordering", async () => {
    const detail = await plan("?order=createdAt.desc&limit=10");
    expect(detail).toContain("mb_records_collection_created_id_idx");
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("uses the updated_at index for updatedAt ordering", async () => {
    const detail = await plan("?order=updatedAt.desc&limit=10");
    expect(detail).toContain("mb_records_collection_updated_id_idx");
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("seeks the updated_at index directly for a keyset continuation", async () => {
    const first = query("?order=updatedAt.asc&limit=10");
    const statement = buildRecordStatement("lessons", first);
    const page = await db.prepare(statement.sql).bind(...statement.params as never[]).all();
    const last = (page.results as Array<{ id: string; updated_at: string }>).at(-1)!;
    const cursorQuery = {
      ...first,
      after: { sortValue: last.updated_at, id: last.id },
    };
    const next = buildRecordStatement("lessons", cursorQuery);
    const explained = await db.prepare(`EXPLAIN QUERY PLAN ${next.sql}`)
      .bind(...next.params as never[]).all();
    const detail = (explained.results as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
    expect(detail).toContain("SEARCH mb_records USING INDEX mb_records_collection_updated_id_idx");
  });

  it("uses the updated_at index for a range filter on updatedAt", async () => {
    const detail = await plan("?filter[updatedAt.gte]=2026-09-03T00:00:00.000Z&order=updatedAt.asc&limit=10");
    expect(detail).toContain("SEARCH mb_records USING INDEX mb_records_collection_updated_id_idx");
  });

  it("uses the expression index for a schemaVersion equality filter", async () => {
    const detail = await plan("?filter[schemaVersion]=2&limit=10");
    expect(detail).toContain("mb_records_collection_schema_version_id_idx");
  });

  it("uses the expression index when schemaVersion is filtered and id ordered", async () => {
    const detail = await plan("?filter[schemaVersion]=2&order=id.asc&limit=10");
    expect(detail).toMatch(/mb_records_collection_schema_version_id_idx|PRIMARY KEY/);
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("never emits OFFSET and never scans the whole records table", async () => {
    for (const search of [
      "?limit=10",
      "?order=createdAt.desc&limit=10",
      "?order=updatedAt.asc&limit=10",
      "?filter[schemaVersion]=1&limit=10",
      "?filter[updatedAt.gt]=2026-09-01T00:00:00.000Z&order=updatedAt.desc&limit=10",
    ]) {
      const statement = buildRecordStatement("lessons", query(search));
      expect(statement.sql).not.toMatch(/OFFSET/i);
      const detail = await plan(search);
      expect(detail).not.toMatch(/SCAN mb_records(?! USING)/);
    }
  });
});

describe("CP-04 project schema v5 upgrades a populated project database", () => {
  it("adds only indexes and preserves every existing record", async () => {
    const upgrade = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-07-28",
      d1Databases: { PROJECT_DB: "cp04-upgrade" },
      cf: false,
    });
    try {
      const target = await upgrade.getD1Database("PROJECT_DB");
      // A tenant sitting on v4, holding real documents.
      for (const migration of projectSchemaMigrations.filter((entry) => entry.version <= 4)) {
        for (const sql of migration.statements) await target.prepare(sql).run();
      }
      await target.batch([
        target.prepare(
          "INSERT INTO mb_records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).bind("tutor_progress", "owner", JSON.stringify({ schemaVersion: 1, lastLessonId: "l-3" }),
          "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
        target.prepare(
          "INSERT INTO mb_records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).bind("tutor_notes", "lesson_3", JSON.stringify({ schemaVersion: 1, text: "note" }),
          "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
      ]);
      const before = await target.prepare("SELECT collection, id, data, created_at, updated_at FROM mb_records ORDER BY collection, id").all();

      const v5 = projectSchemaMigrations.find((entry) => entry.version === 5)!;
      expect(v5.statements.join("\n")).not.toMatch(/ALTER TABLE|DROP|DELETE|UPDATE /i);
      for (const sql of v5.statements) await target.prepare(sql).run();
      // Forward-only and idempotent: replaying the version changes nothing.
      for (const sql of v5.statements) await target.prepare(sql).run();

      const after = await target.prepare("SELECT collection, id, data, created_at, updated_at FROM mb_records ORDER BY collection, id").all();
      expect(after.results).toEqual(before.results);
      expect(
        await target.prepare("SELECT version FROM mb_schema_versions ORDER BY version").all(),
      ).toMatchObject({ results: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }] });

      const indexes = await target.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mb_records' AND name LIKE 'mb_records%'",
      ).all();
      expect((indexes.results as Array<{ name: string }>).map((row) => row.name).sort()).toEqual([
        "mb_records_collection_created_id_idx",
        "mb_records_collection_schema_version_id_idx",
        "mb_records_collection_updated_id_idx",
        // CP-01's index is kept: removing an unused index is a separate,
        // separately justified change, not a side effect of adding a query API.
        "mb_records_collection_updated_idx",
      ].sort());

      // The upgraded database answers a CP-04 query over pre-existing rows.
      const statement = buildRecordStatement(
        "tutor_notes",
        parseRecordQuery(
          new URL("https://minibase.test/v1/data/tutor_notes?filter[schemaVersion]=1&order=updatedAt.desc"),
          DEFAULT_LIMITS,
          "tutor_notes",
        ),
      );
      const rows = await target.prepare(statement.sql).bind(...statement.params as never[]).all();
      expect((rows.results as Array<{ id: string }>).map((row) => row.id)).toEqual(["lesson_3"]);
    } finally {
      await upgrade.dispose();
    }
  });
});
