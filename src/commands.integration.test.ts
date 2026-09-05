import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import {
  executeRecordsUpsertMany,
  parseRecordsUpsertManyCommand,
  recordsUpsertManyFingerprint,
  recordsUpsertManyStatement,
  RECORDS_UPSERT_MANY_COMMAND_TYPE,
  RECORDS_UPSERT_MANY_TRIGGER_NAME,
} from "./commands";
import { DEFAULT_LIMITS } from "./limits";
import { projectSchemaMigrations } from "./project-schema";
import { sha256 } from "./security";

/**
 * CP-05 real-SQL proof.
 *
 * The adapter below is deliberately only a local HTTP envelope: it receives the
 * exact `{ sql, params }` body emitted by `queryProjectD1`, then runs that SQL in
 * Miniflare's real D1/SQLite engine. It does not model SQL, triggers,
 * constraints, conflict behavior, or concurrency. This proves the one-statement
 * mechanism locally without making any claim that REST `{ batch }` is atomic.
 */
let miniflare: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let restCalls: Array<{ sql: string; params: unknown[] }>;

const databaseId = "cp05-project-db";
const principal: DataPrincipal = {
  keyId: "cp05-secret-key",
  projectId: "cp05-project-id",
  databaseId,
  kind: "secret",
  scopes: ["data:write"],
  limits: DEFAULT_LIMITS,
};
const env = {
  CLOUDFLARE_ACCOUNT_ID: "cp05-account",
  CLOUDFLARE_D1_API_TOKEN: "cp05-token-never-returned",
} as MiniBaseEnv;

function command(operations: unknown) {
  return parseRecordsUpsertManyCommand({ operations }, DEFAULT_LIMITS.maxBulkRecords);
}

function execute(key: string, operations: unknown) {
  return executeRecordsUpsertMany(env, principal, key, command(operations));
}

async function all<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params as never[]).all<T>();
  return result.results as T[];
}

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-07-28",
    d1Databases: { PROJECT_DB: databaseId },
    cf: false,
  });
  db = await miniflare.getD1Database("PROJECT_DB");
  for (const migration of projectSchemaMigrations) {
    for (const sql of migration.statements) await db.prepare(sql).run();
  }

  restCalls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/cp05-account/d1/database/${databaseId}/query`,
    );
    const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
    restCalls.push({ sql: body.sql, params: body.params ?? [] });
    try {
      const result = await db.prepare(body.sql).bind(...(body.params ?? []) as never[]).all();
      return Response.json({ success: true, result: [result] });
    } catch {
      // Match the safe external behavior of the actual D1 helper: details stay
      // upstream, while queryProjectD1 turns a non-success envelope into its
      // stable cloudflare_api_error.
      return Response.json({ success: false, errors: [{ message: "sqlite failure" }] }, { status: 500 });
    }
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await miniflare.dispose();
});

describe("CP-05 atomic command statement on real Miniflare D1", () => {
  const twoRecords = [
    { collection: "tasks", id: "task-123", data: { schemaVersion: 1, status: "created" } },
    { collection: "task_events", id: "event-456", data: { schemaVersion: 1, taskId: "task-123", type: "created" } },
  ];

  it("installs v6's static marker/trigger and atomically persists a two-record command in one REST request", async () => {
    const response = await execute("cp05-fresh-key", twoRecords);

    expect(response).toEqual({
      commandId: expect.any(String),
      status: "applied",
      operationCount: 2,
      records: [
        { collection: "tasks", id: "task-123" },
        { collection: "task_events", id: "event-456" },
      ],
      replayed: false,
    });
    // This is one outbound project-D1 REST request, not one request per record.
    expect(restCalls).toHaveLength(1);
    expect(restCalls[0]).toEqual({ sql: recordsUpsertManyStatement, params: expect.any(Array) });
    expect(restCalls[0].params).toHaveLength(9);
    expect(restCalls[0].sql).not.toContain("cp05-fresh-key");
    expect(JSON.stringify(restCalls[0].params)).not.toContain("cp05-fresh-key");

    const columns = await all<{ name: string }>("PRAGMA table_info(mb_commands)");
    const names = columns.map((column) => column.name);
    expect(names).toContain("idempotency_key_hash");
    expect(names).not.toContain("idempotency_key");
    const triggers = await all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      [RECORDS_UPSERT_MANY_TRIGGER_NAME],
    );
    expect(triggers).toEqual([{ name: RECORDS_UPSERT_MANY_TRIGGER_NAME }]);

    const markers = await all<{
      command_id: string;
      command_type: string;
      idempotency_key_hash: string;
      request_fingerprint: string;
      response_json: string;
      status: string;
    }>("SELECT command_id, command_type, idempotency_key_hash, request_fingerprint, response_json, status FROM mb_commands");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      command_id: response.commandId,
      command_type: RECORDS_UPSERT_MANY_COMMAND_TYPE,
      idempotency_key_hash: await sha256("cp05-fresh-key"),
      status: "completed",
    });
    expect(markers[0].idempotency_key_hash).not.toContain("cp05-fresh-key");
    expect(JSON.parse(markers[0].response_json)).toEqual({
      commandId: response.commandId,
      status: "applied",
      operationCount: 2,
      records: response.records,
    });

    const records = await all<{
      collection: string;
      id: string;
      data: string;
      created_at: string;
      updated_at: string;
    }>("SELECT collection, id, data, created_at, updated_at FROM mb_records ORDER BY collection, id");
    expect(records).toHaveLength(2);
    expect(records.map(({ collection, id }) => ({ collection, id }))).toEqual([
      { collection: "task_events", id: "event-456" },
      { collection: "tasks", id: "task-123" },
    ]);
    expect(records.every((record) => record.created_at === record.updated_at)).toBe(true);
  });

  it("preserves an existing target's created_at and stamps every changed target with the command completion time", async () => {
    await db.prepare(
      "INSERT INTO mb_records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "tasks",
      "task-existing",
      JSON.stringify({ schemaVersion: 1, status: "old" }),
      "2020-01-01T00:00:00.000Z",
      "2020-01-02T00:00:00.000Z",
    ).run();

    const response = await execute("cp05-existing-key", [
      { collection: "tasks", id: "task-existing", data: { schemaVersion: 2, status: "new" } },
      { collection: "task_events", id: "event-new", data: { schemaVersion: 2, taskId: "task-existing" } },
    ]);
    const marker = (await all<{ created_at: string; completed_at: string }>(
      "SELECT created_at, completed_at FROM mb_commands WHERE command_id = ?",
      [response.commandId],
    ))[0];
    const records = await all<{ collection: string; id: string; data: string; created_at: string; updated_at: string }>(
      "SELECT collection, id, data, created_at, updated_at FROM mb_records WHERE id IN ('task-existing', 'event-new') ORDER BY id",
    );
    const existing = records.find((record) => record.id === "task-existing")!;
    const created = records.find((record) => record.id === "event-new")!;
    expect(existing).toMatchObject({
      collection: "tasks",
      data: JSON.stringify({ schemaVersion: 2, status: "new" }),
      created_at: "2020-01-01T00:00:00.000Z",
      updated_at: marker.completed_at,
    });
    expect(created).toMatchObject({
      collection: "task_events",
      created_at: marker.created_at,
      updated_at: marker.completed_at,
    });
    expect(marker.created_at).toBe(marker.completed_at);
    expect(restCalls).toHaveLength(1);
  });

  it("upgrades a populated v5 project to v6 without changing existing records, and replays v6 idempotently", async () => {
    const upgrade = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-07-28",
      d1Databases: { PROJECT_DB: "cp05-v5-upgrade" },
      cf: false,
    });
    try {
      const target = await upgrade.getD1Database("PROJECT_DB");
      for (const migration of projectSchemaMigrations.filter((entry) => entry.version <= 5)) {
        for (const sql of migration.statements) await target.prepare(sql).run();
      }
      await target.prepare(
        "INSERT INTO mb_records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("tasks", "existing-task", JSON.stringify({ schemaVersion: 1, status: "existing" }),
        "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z").run();
      await target.prepare(
        "INSERT INTO mb_records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("task_events", "existing-event", JSON.stringify({ schemaVersion: 1, taskId: "existing-task" }),
        "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z").run();
      const before = await target.prepare(
        "SELECT collection, id, data, created_at, updated_at FROM mb_records ORDER BY collection, id",
      ).all();

      const v6 = projectSchemaMigrations.find((entry) => entry.version === 6)!;
      for (const sql of v6.statements) await target.prepare(sql).run();
      for (const sql of v6.statements) await target.prepare(sql).run();

      const after = await target.prepare(
        "SELECT collection, id, data, created_at, updated_at FROM mb_records ORDER BY collection, id",
      ).all();
      expect(after.results).toEqual(before.results);
      expect(await target.prepare("SELECT version FROM mb_schema_versions ORDER BY version").all())
        .toMatchObject({ results: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }] });
      expect(await target.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).bind(RECORDS_UPSERT_MANY_TRIGGER_NAME).all()).toMatchObject({
        results: [{ name: RECORDS_UPSERT_MANY_TRIGGER_NAME }],
      });
    } finally {
      await upgrade.dispose();
    }
  });

  it("replays the persisted response without re-running the trigger or changing timestamps", async () => {
    const first = await execute("cp05-replay-key", twoRecords);
    const beforeRecords = await all<Record<string, unknown>>(
      "SELECT collection, id, data, created_at, updated_at FROM mb_records ORDER BY collection, id",
    );
    const beforeMarker = await all<Record<string, unknown>>(
      "SELECT command_id, request_fingerprint, response_json, created_at, completed_at FROM mb_commands",
    );

    // Object member order is normalized; operation order remains unchanged.
    const replay = await execute("cp05-replay-key", [
      { collection: "tasks", id: "task-123", data: { status: "created", schemaVersion: 1 } },
      { collection: "task_events", id: "event-456", data: { type: "created", taskId: "task-123", schemaVersion: 1 } },
    ]);

    expect(replay).toEqual({ ...first, replayed: true });
    expect(restCalls).toHaveLength(2);
    expect(await all("SELECT collection, id, data, created_at, updated_at FROM mb_records ORDER BY collection, id"))
      .toEqual(beforeRecords);
    expect(await all("SELECT command_id, request_fingerprint, response_json, created_at, completed_at FROM mb_commands"))
      .toEqual(beforeMarker);
  });

  it("fails closed in the same statement when the v6 trigger is absent, without a schema preflight", async () => {
    await db.prepare(`DROP TRIGGER ${RECORDS_UPSERT_MANY_TRIGGER_NAME}`).run();

    await expect(execute("cp05-no-trigger", twoRecords)).rejects.toThrow("command_schema_not_ready");
    expect(restCalls).toHaveLength(1);
    expect(await all("SELECT command_id FROM mb_commands")).toEqual([]);
    expect(await all("SELECT id FROM mb_records")).toEqual([]);
  });

  it("keeps an absent command table as the generic transport/database error", async () => {
    await db.prepare("DROP TABLE mb_commands").run();

    await expect(execute("cp05-no-table", twoRecords)).rejects.toThrow("cloudflare_api_error");
    expect(restCalls).toHaveLength(1);
    expect(await all("SELECT id FROM mb_records")).toEqual([]);
  });

  it("rolls back every target and marker after an injected failure in the second target, then safely retries", async () => {
    const key = "cp05-failure-key";
    const keyHash = await sha256(key);
    const failingOperations = [
      { collection: "tasks", id: "before-explode", data: { schemaVersion: 1, position: 1 } },
      { collection: "tasks", id: "explode", data: { schemaVersion: 1, position: 2 } },
    ];
    // `json_each` walks the input array in index order. The failure is therefore
    // injected when the second target is about to be written, after the first
    // target would otherwise have been processed by the trigger statement.
    await db.prepare(`CREATE TRIGGER cp05_injected_failure
      BEFORE INSERT ON mb_records WHEN NEW.id = 'explode'
      BEGIN SELECT RAISE(ABORT, 'injected command failure'); END`).run();

    await expect(execute(key, failingOperations)).rejects.toThrow("cloudflare_api_error");
    expect(restCalls).toHaveLength(1);
    expect(await all(
      "SELECT collection, id FROM mb_records WHERE id IN ('before-explode', 'explode')",
    )).toEqual([]);
    expect(await all(
      "SELECT command_id, response_json, status FROM mb_commands WHERE idempotency_key_hash = ?",
      [keyHash],
    )).toEqual([]);

    await db.prepare("DROP TRIGGER cp05_injected_failure").run();
    const retried = await execute(key, failingOperations);
    expect(retried.replayed).toBe(false);
    expect(await all(
      "SELECT id FROM mb_records WHERE id IN ('before-explode', 'explode') ORDER BY id",
    )).toEqual([{ id: "before-explode" }, { id: "explode" }]);
    expect(await all(
      "SELECT command_id, status FROM mb_commands WHERE idempotency_key_hash = ?",
      [keyHash],
    )).toEqual([{ command_id: retried.commandId, status: "completed" }]);
    expect(restCalls).toHaveLength(2);
  });

  it("rejects malformed direct markers and markers with a missing operation field before anything completes", async () => {
    const insertMarker = (payload: string, keyHash: string) => db.prepare(`INSERT INTO mb_commands
      (command_id, command_type, idempotency_key_hash, request_fingerprint,
       normalized_payload, response_json, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`).bind(
      crypto.randomUUID(),
      RECORDS_UPSERT_MANY_COMMAND_TYPE,
      keyHash,
      "a".repeat(64),
      payload,
      "{}",
      "2026-09-05T00:00:00.000Z",
      "2026-09-05T00:00:00.000Z",
    ).run();

    await expect(insertMarker("not-json", "b".repeat(64))).rejects.toThrow();
    await expect(insertMarker(
      JSON.stringify({ operations: [{ collection: "tasks", data: { schemaVersion: 1 } }] }),
      "c".repeat(64),
    )).rejects.toThrow();
    await expect(insertMarker(
      JSON.stringify({
        operations: [{ collection: "tasks", id: "direct-extra", data: { schemaVersion: 1 } }],
        unexpected: true,
      }),
      "d".repeat(64),
    )).rejects.toThrow();
    await expect(insertMarker(
      JSON.stringify({ operations: [
        { collection: "tasks", id: "direct-duplicate", data: { schemaVersion: 1 } },
        { collection: "tasks", id: "direct-duplicate", data: { schemaVersion: 2 } },
      ] }),
      "e".repeat(64),
    )).rejects.toThrow();
    await expect(insertMarker(
      JSON.stringify({ operations: [{ collection: "tasks", id: "direct-hash", data: {} }] }),
      "not-a-sha256-hash",
    )).rejects.toThrow();
    expect(await all("SELECT command_id FROM mb_commands")).toEqual([]);
    expect(await all("SELECT id FROM mb_records")).toEqual([]);
  });

  it("serializes concurrent identical commands into exactly one marker and one mutation per target", async () => {
    await db.prepare("CREATE TABLE cp05_mutation_log (collection TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL)").run();
    await db.prepare(`CREATE TRIGGER cp05_log_insert AFTER INSERT ON mb_records
      BEGIN INSERT INTO cp05_mutation_log (collection, id, kind) VALUES (NEW.collection, NEW.id, 'insert'); END`).run();
    await db.prepare(`CREATE TRIGGER cp05_log_update AFTER UPDATE ON mb_records
      BEGIN INSERT INTO cp05_mutation_log (collection, id, kind) VALUES (NEW.collection, NEW.id, 'update'); END`).run();

    const key = "cp05-concurrent-same";
    const [left, right] = await Promise.all([
      execute(key, twoRecords),
      execute(key, twoRecords),
    ]);
    const outcomes = [left.replayed, right.replayed].sort();
    expect(outcomes).toEqual([false, true]);

    const markers = await all<{
      command_id: string;
      request_fingerprint: string;
      response_json: string;
    }>("SELECT command_id, request_fingerprint, response_json FROM mb_commands");
    expect(markers).toHaveLength(1);
    expect(markers[0].request_fingerprint).toBe(await recordsUpsertManyFingerprint(principal.projectId, command(twoRecords)));
    expect(JSON.parse(markers[0].response_json)).toMatchObject({ commandId: markers[0].command_id });

    const records = await all<{ collection: string; id: string }>(
      "SELECT collection, id FROM mb_records ORDER BY collection, id",
    );
    expect(records).toEqual([
      { collection: "task_events", id: "event-456" },
      { collection: "tasks", id: "task-123" },
    ]);
    const mutations = await all<{ collection: string; id: string; kind: string }>(
      "SELECT collection, id, kind FROM cp05_mutation_log ORDER BY collection, id, kind",
    );
    expect(mutations).toEqual([
      { collection: "task_events", id: "event-456", kind: "insert" },
      { collection: "tasks", id: "task-123", kind: "insert" },
    ]);
    expect(restCalls).toHaveLength(2);
  });

  it("allows only one concurrent payload to win a reused key and preserves only that winner's metadata and records", async () => {
    await db.prepare("CREATE TABLE cp05_mutation_log (collection TEXT NOT NULL, id TEXT NOT NULL)").run();
    await db.prepare(`CREATE TRIGGER cp05_log_insert AFTER INSERT ON mb_records
      BEGIN INSERT INTO cp05_mutation_log (collection, id) VALUES (NEW.collection, NEW.id); END`).run();

    const key = "cp05-concurrent-conflict";
    const leftOperations = [
      { collection: "tasks", id: "winner-left", data: { schemaVersion: 1, source: "left" } },
      { collection: "task_events", id: "event-left", data: { schemaVersion: 1, taskId: "winner-left" } },
    ];
    const rightOperations = [
      { collection: "tasks", id: "winner-right", data: { schemaVersion: 1, source: "right" } },
      { collection: "task_events", id: "event-right", data: { schemaVersion: 1, taskId: "winner-right" } },
    ];
    const outcomes = await Promise.allSettled([
      execute(key, leftOperations),
      execute(key, rightOperations),
    ]);
    const successful = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof execute>>> =>
      outcome.status === "fulfilled");
    const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(successful[0].value.replayed).toBe(false);
    expect((failed[0].reason as Error).message).toBe("idempotency_conflict");

    const leftFingerprint = await recordsUpsertManyFingerprint(principal.projectId, command(leftOperations));
    const rightFingerprint = await recordsUpsertManyFingerprint(principal.projectId, command(rightOperations));
    const marker = (await all<{
      command_id: string;
      request_fingerprint: string;
      response_json: string;
    }>("SELECT command_id, request_fingerprint, response_json FROM mb_commands"))[0];
    expect(marker).toBeTruthy();
    expect([leftFingerprint, rightFingerprint]).toContain(marker.request_fingerprint);
    expect(JSON.parse(marker.response_json)).toMatchObject({ commandId: marker.command_id });
    expect(marker.command_id).toBe(successful[0].value.commandId);

    const winnerRecords = successful[0].value.records;
    expect(await all<{ collection: string; id: string }>(
      "SELECT collection, id FROM mb_records ORDER BY collection, id",
    )).toEqual([...winnerRecords].sort((left, right) =>
      `${left.collection}\u0000${left.id}`.localeCompare(`${right.collection}\u0000${right.id}`),
    ));
    expect(await all<{ collection: string; id: string }>(
      "SELECT collection, id FROM cp05_mutation_log ORDER BY collection, id",
    )).toEqual([...winnerRecords].sort((left, right) =>
      `${left.collection}\u0000${left.id}`.localeCompare(`${right.collection}\u0000${right.id}`),
    ));
    expect(restCalls).toHaveLength(2);
  });
});
