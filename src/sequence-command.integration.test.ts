import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { DEFAULT_LIMITS } from "./limits";
import { projectSchemaMigrations } from "./project-schema";
import { executeRecordsAllocateSequence, parseRecordsAllocateSequenceCommand } from "./sequence-command";

let miniflare: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const databaseId = "sequence-db";
const principal: DataPrincipal = { keyId: "secret", projectId: "project", databaseId, kind: "secret", scopes: ["data:write"], limits: DEFAULT_LIMITS };
const env = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_D1_API_TOKEN: "token" } as MiniBaseEnv;
const input = () => parseRecordsAllocateSequenceCommand({ counter: { collection: "counters", id: "kp-2026" }, record: { collection: "proposals", id: crypto.randomUUID(), data: { schemaVersion: 1, title: "Test" } }, sequenceField: "number", prefix: "КП-2026-" });

beforeEach(async () => {
  miniflare = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-07-28", d1Databases: { PROJECT_DB: databaseId }, cf: false });
  db = await miniflare.getD1Database("PROJECT_DB");
  for (const migration of projectSchemaMigrations) for (const sql of migration.statements) await db.prepare(sql).run();
  vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
    try { return Response.json({ success: true, result: [await db.prepare(body.sql).bind(...(body.params ?? []) as never[]).all()] }); }
    catch { return Response.json({ success: false }, { status: 500 }); }
  });
});
afterEach(async () => { vi.unstubAllGlobals(); await miniflare.dispose(); });

describe("CP-08 atomic sequence allocation", () => {
  it("creates the counter and record atomically, persists its response, and replays without consuming another number", async () => {
    const command = input();
    const first = await executeRecordsAllocateSequence(env, principal, "sequence-key", command);
    const replay = await executeRecordsAllocateSequence(env, principal, "sequence-key", command);
    expect(first).toMatchObject({ status: "applied", replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    const rows = await db.prepare("SELECT collection, id, data FROM mb_records ORDER BY collection").all<{ collection: string; id: string; data: string }>();
    expect(rows.results).toEqual([
      { collection: "counters", id: "kp-2026", data: '{"value":1}' },
      { collection: "proposals", id: command.record.id, data: '{"schemaVersion":1,"title":"Test","number":"КП-2026-1"}' },
    ]);
  });

  it("serializes independent creates through the same counter", async () => {
    await Promise.all([
      executeRecordsAllocateSequence(env, principal, "sequence-left", input()),
      executeRecordsAllocateSequence(env, principal, "sequence-right", input()),
    ]);
    const rows = await db.prepare("SELECT data FROM mb_records WHERE collection = 'proposals' ORDER BY json_extract(data, '$.number')").all<{ data: string }>();
    expect(rows.results.map((row: { data: string }) => JSON.parse(row.data).number)).toEqual(["КП-2026-1", "КП-2026-2"]);
  });
});
