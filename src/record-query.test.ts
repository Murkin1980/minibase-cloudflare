import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test-harness";
import { buildRecordStatement, parseRecordQuery, recordQueryContract } from "./record-query";
import { DEFAULT_LIMITS } from "./limits";

/**
 * CP-04 query contract, exercised end to end through the real Worker handler.
 *
 * The properties under test are the ones a query layer can quietly get wrong:
 * an unknown parameter must be refused rather than ignored, no caller text may
 * reach SQL, a page boundary inside equal sort values must neither skip nor
 * repeat a record, and none of it may weaken CP-03 isolation.
 */

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
});

const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secretA = "mb_secret_project_a";
const secretB = "mb_secret_project_b";
const publishableA = "mb_publishable_project_a";

function setup() {
  return createHarness({
    projects: [
      { projectId: projectA, databaseId: "db-a", slug: "project-a" },
      { projectId: projectB, databaseId: "db-b", slug: "project-b" },
    ],
    dataKeys: [
      { key: secretA, projectId: projectA, kind: "secret", scopes: ["data:read", "data:write"] },
      { key: secretB, projectId: projectB, kind: "secret", scopes: ["data:read", "data:write"] },
      { key: publishableA, projectId: projectA, kind: "publishable", scopes: ["data:read"] },
    ],
  });
}

const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

async function seed(
  active: Harness,
  key: string,
  rows: Array<{ id: string; data: Record<string, unknown> }>,
) {
  for (const row of rows) {
    const response = await active.request(`/v1/data/lessons/${row.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(row.data),
    });
    expect(response.status).toBe(200);
  }
}

/** Stamps rows directly so `updated_at` collisions can be constructed exactly. */
function seedRaw(
  active: Harness,
  databaseId: string,
  collection: string,
  rows: Array<{ id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }>,
) {
  const store = active.records.get(databaseId)!;
  if (!store.has(collection)) store.set(collection, new Map());
  for (const row of rows) {
    store.get(collection)!.set(row.id, {
      id: row.id,
      data: JSON.stringify(row.data),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }
}

interface ListBody {
  records: Array<Record<string, unknown>>;
  nextAfter: string | null;
  hasMore: boolean;
}

describe("CP-04 backward compatibility", () => {
  it("serves a parameterless list exactly as before, with the record ID as cursor", async () => {
    harness = setup();
    await seed(harness, secretA, [
      { id: "rec-1", data: { schemaVersion: 1 } },
      { id: "rec-2", data: { schemaVersion: 1 } },
      { id: "rec-3", data: { schemaVersion: 1 } },
    ]);
    harness.d1Calls.length = 0;

    const response = await harness.request("/v1/data/lessons?limit=2", auth(secretA));
    expect(response.status).toBe(200);
    const body = await response.json() as ListBody;
    expect(body.records.map((record) => record.id)).toEqual(["rec-1", "rec-2"]);
    expect(body.nextAfter).toBe("rec-2");
    expect(body.hasMore).toBe(true);
    expect(Object.keys(body.records[0]).sort()).toEqual(["createdAt", "data", "id", "updatedAt"]);

    // A pre-CP-04 client feeds the bare record ID straight back.
    const second = await harness.request("/v1/data/lessons?limit=2&after=rec-2", auth(secretA));
    const secondBody = await second.json() as ListBody;
    expect(secondBody.records.map((record) => record.id)).toEqual(["rec-3"]);
    expect(secondBody.hasMore).toBe(false);

    // Still one D1 REST call per page, and the statement shape is unchanged.
    const listCalls = harness.d1Calls.filter((call) => call.sql.includes("SELECT id, data"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].sql).toContain("WHERE collection = ? ORDER BY id ASC LIMIT ?");
  });

  it("costs exactly one D1 REST round trip for a filtered, ordered, selected page", async () => {
    harness = setup();
    await seed(harness, secretA, [{ id: "rec-1", data: { schemaVersion: 2 } }]);
    harness.d1Calls.length = 0;
    const response = await harness.request(
      "/v1/data/lessons?filter[schemaVersion]=2&order=updatedAt.desc&select=id&limit=10",
      auth(secretA),
    );
    expect(response.status).toBe(200);
    expect(harness.d1Calls).toHaveLength(1);
  });
});

describe("CP-04 filtering", () => {
  it("filters by equality on an allowlisted JSON field", async () => {
    harness = setup();
    await seed(harness, secretA, [
      { id: "rec-1", data: { schemaVersion: 1 } },
      { id: "rec-2", data: { schemaVersion: 2 } },
      { id: "rec-3", data: { schemaVersion: 2 } },
    ]);
    const body = await (await harness.request(
      "/v1/data/lessons?filter[schemaVersion]=2", auth(secretA),
    )).json() as ListBody;
    expect(body.records.map((record) => record.id)).toEqual(["rec-2", "rec-3"]);
  });

  it("supports the timestamp range operators an incremental sync needs", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", [
      { id: "rec-1", data: {}, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "rec-2", data: {}, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
      { id: "rec-3", data: {}, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" },
    ]);
    const body = await (await harness.request(
      "/v1/data/lessons?filter[updatedAt.gt]=2026-09-01T00:00:00.000Z&order=updatedAt.asc",
      auth(secretA),
    )).json() as ListBody;
    expect(body.records.map((record) => record.id)).toEqual(["rec-2", "rec-3"]);

    const bounded = await (await harness.request(
      "/v1/data/lessons?filter[updatedAt.gte]=2026-09-02T00:00:00.000Z&filter[updatedAt.lt]=2026-09-03T00:00:00.000Z",
      auth(secretA),
    )).json() as ListBody;
    expect(bounded.records.map((record) => record.id)).toEqual(["rec-2"]);
  });

  it("rejects an unknown filter field instead of ignoring it", async () => {
    harness = setup();
    const response = await harness.request("/v1/data/lessons?filter[secret]=1", auth(secretA));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_filter" } });
    // Nothing reached the project database.
    expect(harness.d1Calls).toHaveLength(0);
  });

  it("rejects an unknown operator, and an operator a field does not allow", async () => {
    harness = setup();
    expect((await harness.request("/v1/data/lessons?filter[schemaVersion.like]=1", auth(secretA))).status).toBe(400);
    expect(await (await harness.request("/v1/data/lessons?filter[schemaVersion.gt]=1", auth(secretA))).json())
      .toEqual({ error: { code: "invalid_operator" } });
    // `id` is equality-only: ranges over ids belong to the cursor, not a filter.
    expect(await (await harness.request("/v1/data/lessons?filter[id.gt]=rec-1", auth(secretA))).json())
      .toEqual({ error: { code: "invalid_operator" } });
  });

  it("rejects a malformed filter value rather than binding it", async () => {
    harness = setup();
    expect((await harness.request("/v1/data/lessons?filter[schemaVersion]=abc", auth(secretA))).status).toBe(400);
    expect((await harness.request("/v1/data/lessons?filter[updatedAt]=yesterday", auth(secretA))).status).toBe(400);
    expect((await harness.request("/v1/data/lessons?filter[id]=../../etc", auth(secretA))).status).toBe(400);
  });
});

describe("CP-04 timestamp normalization", () => {
  /** Binds one timestamp filter and returns the value that reaches SQL. */
  const bound = (field: string, value: string) =>
    buildRecordStatement("lessons", parseRecordQuery(
      new URL(`https://minibase.test/v1/data/lessons?filter[${field}]=${encodeURIComponent(value)}`),
      DEFAULT_LIMITS,
      "lessons",
    )).params[1];

  it("normalizes a Z instant to canonical UTC with milliseconds", () => {
    expect(bound("updatedAt", "2026-09-01T00:00:00Z")).toBe("2026-09-01T00:00:00.000Z");
    expect(bound("updatedAt", "2026-09-01T12:34:56.7Z")).toBe("2026-09-01T12:34:56.700Z");
    // An already-canonical value is returned unchanged.
    expect(bound("updatedAt", "2026-09-01T00:00:00.000Z")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("converts an offset instant to UTC rather than binding the offset text", () => {
    expect(bound("updatedAt", "2026-09-01T05:00:00+05:00")).toBe("2026-09-01T00:00:00.000Z");
    expect(bound("createdAt", "2026-08-31T19:00:00-05:00")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("gives equivalent instants byte-identical bound values", () => {
    const spellings = [
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T05:00:00+05:00",
      "2026-08-31T19:00:00-05:00",
    ];
    const values = spellings.map((value) => bound("updatedAt", value));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe("2026-09-01T00:00:00.000Z");
  });

  it("gives equivalent instants the same cursor digest, so paging survives respelling", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", [
      { id: "rec-1", data: {}, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
      { id: "rec-2", data: {}, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" },
    ]);
    const first = await (await harness.request(
      "/v1/data/lessons?filter[updatedAt.gte]=2026-09-01T00:00:00.000Z&order=updatedAt.asc&limit=1",
      auth(secretA),
    )).json() as ListBody;
    // Same instant, different spelling: the continuation is still accepted.
    const next = await harness.request(
      `/v1/data/lessons?filter[updatedAt.gte]=${encodeURIComponent("2026-09-01T05:00:00+05:00")}&order=updatedAt.asc&limit=1&after=${encodeURIComponent(first.nextAfter!)}`,
      auth(secretA),
    );
    expect(next.status).toBe(200);
    expect(((await next.json()) as ListBody).records.map((record) => record.id)).toEqual(["rec-2"]);
  });

  it("rejects a timestamp without an explicit timezone", async () => {
    harness = setup();
    for (const value of [
      "2026-09-01T00:00:00",
      "2026-09-01T00:00:00.000",
      "2026-09-01 00:00:00Z",
      "2026-09-01",
      "2026-09-01T00:00:00+0500",
      // An unencoded `+` arrives as a space, which is not a timezone. Rejecting
      // it is better than guessing: the caller gets a deterministic 400 rather
      // than a filter quietly interpreted in the wrong zone.
      "2026-09-01T00:00:00 05:00",
    ]) {
      const response = await harness.request(
        `/v1/data/lessons?filter[updatedAt]=${encodeURIComponent(value)}`, auth(secretA),
      );
      expect(response.status, value).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_filter" } });
    }
  });

  it("rejects a calendar date that does not exist instead of rolling it over", async () => {
    harness = setup();
    for (const value of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-09-31T00:00:00Z",
      "2026-09-01T25:00:00Z",
    ]) {
      const response = await harness.request(
        `/v1/data/lessons?filter[createdAt]=${encodeURIComponent(value)}`, auth(secretA),
      );
      expect(response.status, value).toBe(400);
    }
    // A real leap day is accepted.
    expect(bound("createdAt", "2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("filters, orders, and pages correctly across mixed input spellings", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", [
      { id: "rec-1", data: {}, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "rec-2", data: {}, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
      { id: "rec-3", data: {}, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" },
    ]);
    // `+05:00` is the instant 2026-09-02T00:00:00Z. As raw text it would sort
    // after every stored `...Z` value and match nothing; normalized, it is a
    // correct lower bound.
    const offsetForm = await (await harness.request(
      `/v1/data/lessons?filter[updatedAt.gte]=${encodeURIComponent("2026-09-02T05:00:00+05:00")}&order=updatedAt.asc`,
      auth(secretA),
    )).json() as ListBody;
    expect(offsetForm.records.map((record) => record.id)).toEqual(["rec-2", "rec-3"]);

    const utcForm = await (await harness.request(
      "/v1/data/lessons?filter[updatedAt.gte]=2026-09-02T00:00:00.000Z&order=updatedAt.asc", auth(secretA),
    )).json() as ListBody;
    expect(utcForm.records.map((record) => record.id)).toEqual(offsetForm.records.map((record) => record.id));

    // Paging a normalized range yields every record exactly once.
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url = `/v1/data/lessons?filter[createdAt.gte]=${encodeURIComponent("2026-08-31T19:00:00-05:00")}&order=createdAt.asc&limit=1${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const body = await (await harness.request(url, auth(secretA))).json() as ListBody;
      seen.push(...body.records.map((record) => String(record.id)));
      if (!body.hasMore) break;
      after = body.nextAfter;
    }
    expect(seen).toEqual(["rec-1", "rec-2", "rec-3"]);
  });
});

describe("CP-04 ordering and stable keyset pagination", () => {
  it("orders ascending and descending on an allowlisted field", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", [
      { id: "rec-1", data: {}, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" },
      { id: "rec-2", data: {}, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    const ascending = await (await harness.request("/v1/data/lessons?order=updatedAt.asc", auth(secretA))).json() as ListBody;
    expect(ascending.records.map((record) => record.id)).toEqual(["rec-2", "rec-1"]);
    const descending = await (await harness.request("/v1/data/lessons?order=updatedAt.desc", auth(secretA))).json() as ListBody;
    expect(descending.records.map((record) => record.id)).toEqual(["rec-1", "rec-2"]);
  });

  it("breaks ties by id so equal timestamps have one total order", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", ["c", "a", "b", "d"].map((suffix) => ({
      id: `rec-${suffix}`,
      data: {},
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })));
    const ascending = await (await harness.request("/v1/data/lessons?order=updatedAt.asc", auth(secretA))).json() as ListBody;
    expect(ascending.records.map((record) => record.id)).toEqual(["rec-a", "rec-b", "rec-c", "rec-d"]);
    const descending = await (await harness.request("/v1/data/lessons?order=updatedAt.desc", auth(secretA))).json() as ListBody;
    expect(descending.records.map((record) => record.id)).toEqual(["rec-d", "rec-c", "rec-b", "rec-a"]);
  });

  it("walks every page without skipping or duplicating a record, even with identical sort values", async () => {
    harness = setup();
    // Ten records, all sharing one `updated_at`: the case a naive `>` cursor on
    // the sort column alone either loops forever on or skips wholesale.
    seedRaw(harness, "db-a", "lessons", Array.from({ length: 10 }, (_, index) => ({
      id: `rec-${String(index).padStart(2, "0")}`,
      data: { schemaVersion: 1 },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })));

    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = `/v1/data/lessons?order=updatedAt.asc&limit=3${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const body = await (await harness.request(url, auth(secretA))).json() as ListBody;
      seen.push(...body.records.map((record) => String(record.id)));
      if (!body.hasMore) break;
      after = body.nextAfter;
    }
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(10);
    expect(seen).toHaveLength(10);
  });

  it("combines filter, order, and pagination consistently", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", Array.from({ length: 6 }, (_, index) => ({
      id: `rec-${index}`,
      data: { schemaVersion: index % 2 },
      createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      updatedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
    })));
    const first = await (await harness.request(
      "/v1/data/lessons?filter[schemaVersion]=1&order=createdAt.desc&limit=2", auth(secretA),
    )).json() as ListBody;
    expect(first.records.map((record) => record.id)).toEqual(["rec-5", "rec-3"]);
    expect(first.hasMore).toBe(true);
    const second = await (await harness.request(
      `/v1/data/lessons?filter[schemaVersion]=1&order=createdAt.desc&limit=2&after=${encodeURIComponent(first.nextAfter!)}`,
      auth(secretA),
    )).json() as ListBody;
    expect(second.records.map((record) => record.id)).toEqual(["rec-1"]);
    expect(second.hasMore).toBe(false);
  });

  it("rejects an unknown order field or direction", async () => {
    harness = setup();
    expect(await (await harness.request("/v1/data/lessons?order=data.asc", auth(secretA))).json())
      .toEqual({ error: { code: "invalid_order" } });
    expect((await harness.request("/v1/data/lessons?order=updatedAt.sideways", auth(secretA))).status).toBe(400);
    expect((await harness.request("/v1/data/lessons?order=rowid", auth(secretA))).status).toBe(400);
  });
});

describe("CP-04 field selection", () => {
  it("returns only the requested response fields", async () => {
    harness = setup();
    await seed(harness, secretA, [{ id: "rec-1", data: { schemaVersion: 1 } }]);
    const body = await (await harness.request("/v1/data/lessons?select=id,updatedAt", auth(secretA))).json() as ListBody;
    expect(Object.keys(body.records[0]).sort()).toEqual(["id", "updatedAt"]);
  });

  it("does not let selection reach an internal column or weaken the cursor", async () => {
    harness = setup();
    await seed(harness, secretA, [
      { id: "rec-1", data: {} },
      { id: "rec-2", data: {} },
    ]);
    for (const select of ["collection", "rowid", "data,collection", "*", "created_at"]) {
      const response = await harness.request(`/v1/data/lessons?select=${encodeURIComponent(select)}`, auth(secretA));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_select" } });
    }
    // Selecting nothing but `data` still produces a usable cursor: selection is
    // applied to the response only, never to the keyset.
    const page = await (await harness.request("/v1/data/lessons?select=data&limit=1", auth(secretA))).json() as ListBody;
    expect(Object.keys(page.records[0])).toEqual(["data"]);
    expect(page.nextAfter).toBe("rec-1");
    expect(page.hasMore).toBe(true);
  });
});

describe("CP-04 cursor contract", () => {
  it("is opaque and rejects a malformed cursor fail-closed", async () => {
    harness = setup();
    await seed(harness, secretA, [{ id: "rec-1", data: {} }]);
    const page = await (await harness.request("/v1/data/lessons?order=updatedAt.asc&limit=1", auth(secretA))).json() as ListBody;
    expect(page.nextAfter).toMatch(/^mbq1\./);
    expect(page.nextAfter).not.toContain("rec-1");

    for (const cursor of ["rec-1", "mbq1.!!!", "mbq1.", "{}", "mbq1.eyJhIjoxfQ"]) {
      const response = await harness.request(
        `/v1/data/lessons?order=updatedAt.asc&after=${encodeURIComponent(cursor)}`, auth(secretA),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_cursor" } });
    }
  });

  it("refuses a cursor issued for a different filter, order, or collection", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", [
      { id: "rec-1", data: { schemaVersion: 1 }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "rec-2", data: { schemaVersion: 1 }, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
    ]);
    seedRaw(harness, "db-a", "notes", [
      { id: "rec-1", data: { schemaVersion: 1 }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    const page = await (await harness.request(
      "/v1/data/lessons?filter[schemaVersion]=1&order=updatedAt.asc&limit=1", auth(secretA),
    )).json() as ListBody;
    const cursor = encodeURIComponent(page.nextAfter!);

    for (const mismatch of [
      `/v1/data/lessons?order=updatedAt.asc&after=${cursor}`,                       // filter dropped
      `/v1/data/lessons?filter[schemaVersion]=2&order=updatedAt.asc&after=${cursor}`, // filter changed
      `/v1/data/lessons?filter[schemaVersion]=1&order=updatedAt.desc&after=${cursor}`, // direction flipped
      `/v1/data/lessons?filter[schemaVersion]=1&order=createdAt.asc&after=${cursor}`,  // field changed
      `/v1/data/notes?filter[schemaVersion]=1&order=updatedAt.asc&after=${cursor}`,    // other collection
    ]) {
      const response = await harness.request(mismatch, auth(secretA));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_cursor" } });
    }

    // The matching continuation still works, so the check is not simply refusing everything.
    const next = await harness.request(
      `/v1/data/lessons?filter[schemaVersion]=1&order=updatedAt.asc&limit=1&after=${cursor}`, auth(secretA),
    );
    expect(next.status).toBe(200);
    expect(((await next.json()) as ListBody).records.map((record) => record.id)).toEqual(["rec-2"]);
  });

  it("ignores query-string parameter order when validating a cursor", async () => {
    harness = setup();
    seedRaw(harness, "db-a", "lessons", [
      { id: "rec-1", data: { schemaVersion: 1 }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "rec-2", data: { schemaVersion: 1 }, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
    ]);
    const page = await (await harness.request(
      "/v1/data/lessons?filter[schemaVersion]=1&filter[updatedAt.gte]=2026-09-01T00:00:00.000Z&order=updatedAt.asc&limit=1",
      auth(secretA),
    )).json() as ListBody;
    const reordered = await harness.request(
      `/v1/data/lessons?order=updatedAt.asc&filter[updatedAt.gte]=2026-09-01T00:00:00.000Z&filter[schemaVersion]=1&limit=1&after=${encodeURIComponent(page.nextAfter!)}`,
      auth(secretA),
    );
    expect(reordered.status).toBe(200);
  });
});

describe("CP-04 injection resistance", () => {
  const payloads = [
    "1' OR '1'='1",
    "1; DROP TABLE mb_records--",
    "') UNION SELECT key_hash FROM api_keys--",
    "id/**/",
    "1 OR 1=1",
  ];

  it("never lets a filter value, field, order, or select become SQL", async () => {
    harness = setup();
    await seed(harness, secretA, [{ id: "rec-1", data: { schemaVersion: 1 } }]);
    harness.d1Calls.length = 0;

    for (const payload of payloads) {
      const encoded = encodeURIComponent(payload);
      for (const search of [
        `?filter[schemaVersion]=${encoded}`,
        `?filter[${encoded}]=1`,
        `?order=${encoded}`,
        `?order=updatedAt.${encoded}`,
        `?select=${encoded}`,
        `?after=${encoded}`,
      ]) {
        const response = await harness.request(`/v1/data/lessons${search}`, auth(secretA));
        expect(response.status).toBe(400);
      }
    }
    // Rejection happens before any project database is addressed.
    expect(harness.d1Calls).toHaveLength(0);
  });

  it("binds a legitimate value rather than interpolating it", () => {
    const statement = buildRecordStatement(
      "lessons",
      parseRecordQuery(
        new URL("https://minibase.test/v1/data/lessons?filter[schemaVersion]=3&filter[updatedAt.gt]=2026-09-01T00:00:00Z"),
        DEFAULT_LIMITS,
        "lessons",
      ),
    );
    expect(statement.sql).not.toContain("3");
    expect(statement.sql).not.toContain("2026");
    // The timestamp is bound in canonical UTC, not as the caller spelled it.
    expect(statement.params).toEqual(["lessons", 3, "2026-09-01T00:00:00.000Z", 51]);
    expect(statement.sql).not.toMatch(/OFFSET/i);
  });

  it("exposes only the declared allowlists", () => {
    expect(Object.keys(recordQueryContract.filters).sort()).toEqual(["createdAt", "id", "schemaVersion", "updatedAt"]);
    expect(recordQueryContract.orders.sort()).toEqual(["createdAt", "id", "updatedAt"]);
    expect(recordQueryContract.select.sort()).toEqual(["createdAt", "data", "id", "updatedAt"]);
    expect(recordQueryContract.directions).toEqual(["asc", "desc"]);
  });
});

describe("CP-04 isolation and quota guarantees are unchanged", () => {
  it("cannot filter or order across project boundaries", async () => {
    harness = setup();
    await seed(harness, secretA, [{ id: "rec-a", data: { schemaVersion: 1 } }]);
    await seed(harness, secretB, [{ id: "rec-b", data: { schemaVersion: 1 } }]);
    harness.d1Calls.length = 0;

    const body = await (await harness.request(
      "/v1/data/lessons?filter[schemaVersion]=1&order=updatedAt.desc", auth(secretB),
    )).json() as ListBody;
    expect(body.records.map((record) => record.id)).toEqual(["rec-b"]);
    expect([...new Set(harness.d1Calls.map((call) => call.databaseId))]).toEqual(["db-b"]);

    // Project A's record is unreachable through B's credential by id filter too.
    const targeted = await (await harness.request(
      "/v1/data/lessons?filter[id]=rec-a", auth(secretB),
    )).json() as ListBody;
    expect(targeted.records).toEqual([]);
    expect(harness.d1Calls.every((call) => call.databaseId === "db-b")).toBe(true);
  });

  it("keeps a publishable key read-only while allowing it to query", async () => {
    harness = setup();
    await seed(harness, secretA, [{ id: "rec-1", data: { schemaVersion: 1 } }]);
    const read = await harness.request("/v1/data/lessons?order=updatedAt.desc&select=id", auth(publishableA));
    expect(read.status).toBe(200);
    const write = await harness.request("/v1/data/lessons/rec-1", {
      method: "PUT",
      headers: { authorization: `Bearer ${publishableA}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 2 }),
    });
    expect(write.status).toBe(401);
  });

  it("still enforces the project's maxPageSize on a CP-04 query", async () => {
    harness = createHarness({
      projects: [{ projectId: projectA, databaseId: "db-a", slug: "project-a", quotas: { maxPageSize: 5 } }],
      dataKeys: [{ key: secretA, projectId: projectA, kind: "secret", scopes: ["data:read", "data:write"] }],
    });
    const denied = await harness.request("/v1/data/lessons?order=updatedAt.desc&limit=6", auth(secretA));
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: { code: "invalid_limit" } });
    expect((await harness.request("/v1/data/lessons?order=updatedAt.desc&limit=5", auth(secretA))).status).toBe(200);
  });

  it("refuses a query on an unauthenticated request before touching D1", async () => {
    harness = setup();
    const response = await harness.request("/v1/data/lessons?filter[schemaVersion]=1&order=updatedAt.desc");
    expect(response.status).toBe(401);
    expect(harness.d1Calls).toHaveLength(0);
  });
});
