import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { DataPrincipal, MiniBaseEnv } from "./contracts";
import { DEFAULT_LIMITS } from "./limits";
import { projectSchemaMigrations } from "./project-schema";
import { executeRecordsAllocateSeededSequence, parseRecordsAllocateSeededSequenceCommand } from "./seeded-sequence-command";

let miniflare: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const databaseId = "seeded-sequence-db";
const principal: DataPrincipal = { keyId: "secret", projectId: "project", databaseId, kind: "secret", scopes: ["data:write"], limits: DEFAULT_LIMITS };
const env = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_D1_API_TOKEN: "token" } as MiniBaseEnv;
function input(id = crypto.randomUUID()) {
  return parseRecordsAllocateSeededSequenceCommand({ counter: { collection: "counters", id: "kp-2026" }, record: { collection: "proposals", id, data: { schemaVersion: 1 } }, sequenceField: "number", prefix: "КП-2026-", minimumDigits: 3, initialValue: 41 });
}
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
describe("CP-09 seeded padded sequence", () => {
  it("uses the seed only for the first allocation and preserves fixed-width numbers", async () => {
    const firstInput = input();
    const first = await executeRecordsAllocateSeededSequence(env, principal, "seeded-first", firstInput);
    const secondInput = input();
    await executeRecordsAllocateSeededSequence(env, principal, "seeded-second", secondInput);
    expect(first).toMatchObject({ status: "applied", replayed: false });
    const rows = await db.prepare("SELECT data FROM mb_records WHERE collection = 'proposals' ORDER BY json_extract(data, '$.number')").all<{ data: string }>();
    expect(rows.results.map((row: { data: string }) => JSON.parse(row.data).number)).toEqual(["КП-2026-042", "КП-2026-043"]);
  });
});
