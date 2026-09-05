import { afterEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "./idempotency";
import { createHarness, type Harness, type HarnessOptions, type HarnessProject } from "./test-harness";

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
});

const projectA = "project-a";
const projectB = "project-b";
const secretA = "mb_secret_cp05_project_a";
const secretB = "mb_secret_cp05_project_b";
const publishableA = "mb_publishable_cp05_project_a";
const managementKey = "mb_management_cp05_owner";

const twoOperations = {
  operations: [
    { collection: "tasks", id: "task-123", data: { schemaVersion: 1, status: "created" } },
    { collection: "task_events", id: "event-456", data: { schemaVersion: 1, taskId: "task-123", type: "created" } },
  ],
};

function setup(options: HarnessOptions = {}) {
  const {
    projects = [],
    dataKeys = [],
    managementKeys = [],
    ...rest
  } = options;
  const defaultProject: HarnessProject = { projectId: projectA, databaseId: "database-a", slug: "alpha" };
  return createHarness({
    projects: [
      { ...defaultProject, ...(projects[0] ?? {}) },
      ...projects.slice(1),
    ],
    dataKeys: [
      { key: secretA, projectId: projectA, kind: "secret", scopes: ["data:read", "data:write"] },
      // A deliberately corrupt/legacy row proves the command route itself—not
      // only key-creation validation—keeps publishable credentials out.
      { key: publishableA, projectId: projectA, kind: "publishable", scopes: ["data:read", "data:write"] },
      ...dataKeys,
    ],
    managementKeys: [
      { key: managementKey, scopes: ["projects:write"] },
      ...managementKeys,
    ],
    ...rest,
  });
}

function commandHeaders(key = secretA, idempotencyKey = "cp05-key") {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
}

async function post(
  body: unknown = twoOperations,
  key = secretA,
  idempotencyKey = "cp05-key",
): Promise<Response> {
  return harness!.request("/v1/commands/records:upsert-many", {
    method: "POST",
    headers: commandHeaders(key, idempotencyKey),
    body: JSON.stringify(body),
  });
}

describe("CP-05 records:upsert-many HTTP contract", () => {
  it("atomically upserts two records and issues exactly one project-D1 REST request", async () => {
    harness = setup();
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json() as {
      commandId: string;
      status: string;
      operationCount: number;
      records: Array<{ collection: string; id: string }>;
      replayed: boolean;
    };
    expect(body).toEqual({
      commandId: expect.any(String),
      status: "applied",
      operationCount: 2,
      records: [
        { collection: "tasks", id: "task-123" },
        { collection: "task_events", id: "event-456" },
      ],
      replayed: false,
    });
    expect(harness.d1Calls).toHaveLength(1);
    expect(harness.d1Calls[0].sql).toContain("INSERT INTO mb_commands");
    expect(harness.d1Calls[0].sql).toContain("ON CONFLICT(command_type, idempotency_key_hash)");
    expect(harness.d1Calls[0].sql).not.toContain("task-123");
    expect(harness.d1Calls[0].params).toHaveLength(9);
    expect(JSON.stringify(harness.d1Calls[0].params)).not.toContain("cp05-key");

    // The records are visible through their normal project-scoped read routes.
    const task = await harness.request("/v1/data/tasks/task-123", {
      headers: { authorization: `Bearer ${secretA}` },
    });
    const event = await harness.request("/v1/data/task_events/event-456", {
      headers: { authorization: `Bearer ${secretA}` },
    });
    expect((await task.json() as { data: unknown }).data).toEqual({ schemaVersion: 1, status: "created" });
    expect((await event.json() as { data: unknown }).data).toEqual({
      schemaVersion: 1, taskId: "task-123", type: "created",
    });
    expect(harness.commands.get("database-a")?.size).toBe(1);
    expect(harness.commandMutations.get("database-a")?.get("tasks\u0000task-123")).toBe(1);
    expect(harness.commandMutations.get("database-a")?.get("task_events\u0000event-456")).toBe(1);
    const marker = [...harness.commands.get("database-a")!.values()][0];
    expect(marker.idempotency_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(marker)).not.toContain("cp05-key");
  });

  it("normalizes object-key order, replays the stored result, and never re-runs mutations", async () => {
    harness = setup();
    const first = await (await post(twoOperations, secretA, "canonical-key")).json() as Record<string, unknown>;
    const recordSnapshot = JSON.stringify(harness.records.get("database-a"));
    const markerSnapshot = JSON.stringify([...harness.commands.get("database-a")!.values()]);

    const replayBody = {
      operations: [
        { collection: "tasks", id: "task-123", data: { status: "created", schemaVersion: 1 } },
        { collection: "task_events", id: "event-456", data: { type: "created", taskId: "task-123", schemaVersion: 1 } },
      ],
    };
    const replayResponse = await post(replayBody, secretA, "canonical-key");
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as Record<string, unknown>;
    expect(replay).toEqual({ ...first, replayed: true });
    expect(replay.commandId).toBe(first.commandId);
    expect(JSON.stringify(harness.records.get("database-a"))).toBe(recordSnapshot);
    expect(JSON.stringify([...harness.commands.get("database-a")!.values()])).toBe(markerSnapshot);
    expect(harness.commandMutations.get("database-a")?.get("tasks\u0000task-123")).toBe(1);
    expect(harness.commandMutations.get("database-a")?.get("task_events\u0000event-456")).toBe(1);
    expect(harness.d1Calls).toHaveLength(2);
  });

  it("returns conflict without exposing or changing the winning command", async () => {
    harness = setup();
    const first = await (await post(twoOperations, secretA, "conflict-key")).json() as Record<string, unknown>;
    const recordSnapshot = JSON.stringify(harness.records.get("database-a"));
    const markerSnapshot = JSON.stringify([...harness.commands.get("database-a")!.values()]);

    const conflict = await post({
      operations: [
        { collection: "tasks", id: "task-123", data: { schemaVersion: 1, status: "different" } },
      ],
    }, secretA, "conflict-key");
    expect(conflict.status).toBe(409);
    const body = await conflict.json() as { error: { code: string } };
    expect(body).toEqual({ error: { code: "idempotency_conflict" } });
    expect(JSON.stringify(body)).not.toContain("conflict-key");
    expect(JSON.stringify(body)).not.toContain("fingerprint");
    expect(JSON.stringify(harness.records.get("database-a"))).toBe(recordSnapshot);
    expect(JSON.stringify([...harness.commands.get("database-a")!.values()])).toBe(markerSnapshot);
    expect(harness.d1Calls).toHaveLength(2);
    expect(first.replayed).toBe(false);
  });

  it("scopes a key to its authenticated project and prevents cross-project command writes", async () => {
    harness = createHarness({
      projects: [
        { projectId: projectA, databaseId: "database-a", slug: "alpha" },
        { projectId: projectB, databaseId: "database-b", slug: "beta" },
      ],
      dataKeys: [
        { key: secretA, projectId: projectA, kind: "secret", scopes: ["data:read", "data:write"] },
        { key: secretB, projectId: projectB, kind: "secret", scopes: ["data:read", "data:write"] },
      ],
    });

    const alpha = await post({
      operations: [{ collection: "tasks", id: "shared-id", data: { owner: "alpha" } }],
    }, secretA, "same-key-in-two-projects");
    const beta = await post({
      operations: [{ collection: "tasks", id: "shared-id", data: { owner: "beta" } }],
    }, secretB, "same-key-in-two-projects");
    expect(alpha.status).toBe(200);
    expect(beta.status).toBe(200);
    expect(harness.commands.get("database-a")?.size).toBe(1);
    expect(harness.commands.get("database-b")?.size).toBe(1);
    expect(harness.records.get("database-a")?.get("tasks")?.get("shared-id")?.data).toBe('{"owner":"alpha"}');
    expect(harness.records.get("database-b")?.get("tasks")?.get("shared-id")?.data).toBe('{"owner":"beta"}');

    const betaRead = await harness.request("/v1/data/tasks/shared-id", {
      headers: { authorization: `Bearer ${secretB}` },
    });
    expect((await betaRead.json() as { data: unknown }).data).toEqual({ owner: "beta" });
    const alphaRead = await harness.request("/v1/data/tasks/shared-id", {
      headers: { authorization: `Bearer ${secretA}` },
    });
    expect((await alphaRead.json() as { data: unknown }).data).toEqual({ owner: "alpha" });
    expect(new Set(harness.d1Calls.map((call) => call.databaseId))).toEqual(new Set(["database-a", "database-b"]));
  });

  it("accepts a secret project:admin principal for the command", async () => {
    const adminSecret = "mb_secret_cp05_project_admin";
    harness = setup({
      dataKeys: [{ key: adminSecret, projectId: projectA, kind: "secret", scopes: ["project:admin"] }],
    });
    const response = await post(twoOperations, adminSecret, "project-admin-key");
    expect(response.status).toBe(200);
    expect((await response.json() as { replayed: boolean }).replayed).toBe(false);
    expect(harness.d1Calls).toHaveLength(1);
  });

  it("requires a secret data:write principal and preserves origin/rate policies", async () => {
    harness = setup({
      projects: [{ projectId: projectA, databaseId: "database-a", slug: "alpha", origins: ["https://alpha.test"] }],
    });
    const publishable = await post(twoOperations, publishableA, "publishable-key");
    expect(publishable.status).toBe(401);
    const management = await post(twoOperations, managementKey, "management-key");
    expect(management.status).toBe(401);
    const origin = await harness.request("/v1/commands/records:upsert-many", {
      method: "POST",
      headers: { ...commandHeaders(secretA, "origin-key"), origin: "https://elsewhere.test" },
      body: JSON.stringify(twoOperations),
    });
    expect(origin.status).toBe(403);
    expect(await origin.json()).toEqual({ error: { code: "origin_not_allowed" } });
    expect(harness.d1Calls).toHaveLength(0);

    harness.dispose();
    harness = setup({ rateLimitDeniedProjects: [projectA] });
    const rateLimited = await post(twoOperations, secretA, "rate-key");
    expect(rateLimited.status).toBe(429);
    expect(await rateLimited.json()).toEqual({ error: { code: "rate_limited" } });
    expect(harness.d1Calls).toHaveLength(0);

    harness.dispose();
    harness = setup({ omitRateLimiters: true, rateLimiterRequired: true });
    const limiterUnavailable = await post(twoOperations, secretA, "limiter-unavailable-key");
    expect(limiterUnavailable.status).toBe(503);
    expect(await limiterUnavailable.json()).toEqual({ error: { code: "rate_limiter_unavailable" } });
    expect(harness.d1Calls).toHaveLength(0);
  });

  it("supports command CORS preflight with POST and Idempotency-Key", async () => {
    harness = setup();
    const response = await harness.request("/v1/commands/records:upsert-many", {
      method: "OPTIONS",
      headers: { origin: "https://alpha.test" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    expect(harness.d1Calls).toEqual([]);
  });

  it("rejects missing, empty, and oversized idempotency keys before project D1", async () => {
    harness = setup();
    const request = (idempotencyKey: string | undefined) => harness!.request("/v1/commands/records:upsert-many", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretA}`,
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      body: JSON.stringify(twoOperations),
    });
    for (const key of [undefined, "", "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)]) {
      const response = await request(key);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_idempotency_key" } });
    }
    expect(harness.d1Calls).toEqual([]);
  });

  it("uses the existing bounded JSON and content-type guards before project D1", async () => {
    harness = setup({ limits: { MB_MAX_JSON_BYTES: "20" } });
    const tooLarge = await post(twoOperations, secretA, "too-large-body");
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: { code: "request_body_too_large" } });

    const wrongType = await harness.request("/v1/commands/records:upsert-many", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretA}`,
        "content-type": "text/plain",
        "idempotency-key": "wrong-content-type",
      },
      body: JSON.stringify(twoOperations),
    });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ error: { code: "content_type_must_be_application_json" } });

    const invalidJson = await harness.request("/v1/commands/records:upsert-many", {
      method: "POST",
      headers: commandHeaders(secretA, "invalid-json"),
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: { code: "invalid_json" } });
    expect(harness.d1Calls).toEqual([]);
  });

  it("enforces deployment and project maxBulkRecords quotas", async () => {
    harness = setup({ limits: { MB_MAX_BULK_RECORDS: "1" } });
    const deploymentLimited = await post(twoOperations, secretA, "deployment-limit");
    expect(deploymentLimited.status).toBe(400);
    expect(await deploymentLimited.json()).toEqual({ error: { code: "bulk_limit_exceeded" } });
    expect(harness.d1Calls).toEqual([]);

    harness.dispose();
    harness = setup({
      projects: [{
        projectId: projectA,
        databaseId: "database-a",
        slug: "alpha",
        quotas: { maxBulkRecords: 1 },
      }],
    });
    const projectLimited = await post(twoOperations, secretA, "project-limit");
    expect(projectLimited.status).toBe(400);
    expect(await projectLimited.json()).toEqual({ error: { code: "bulk_limit_exceeded" } });
    expect(harness.d1Calls).toEqual([]);
  });

  it("rejects unknown fields, empty/duplicate operations, internal collections, invalid identifiers, and invalid data", async () => {
    harness = setup();
    const cases: Array<{ body: unknown; code: string }> = [
      { body: { operations: [] }, code: "invalid_command" },
      { body: { operations: twoOperations.operations, projectId: projectB }, code: "invalid_command" },
      { body: { operations: [{ ...twoOperations.operations[0], rawSql: "DELETE FROM mb_records" }] }, code: "invalid_command" },
      { body: { operations: [twoOperations.operations[0], twoOperations.operations[0]] }, code: "invalid_command" },
      { body: { operations: [{ collection: "mb_commands", id: "marker", data: {} }] }, code: "invalid_collection" },
      { body: { operations: [{ collection: "tasks; DROP TABLE mb_records", id: "x", data: {} }] }, code: "invalid_collection" },
      { body: { operations: [{ collection: "tasks", id: "../escape", data: {} }] }, code: "invalid_record_id" },
      { body: { operations: [{ collection: "tasks", id: "x", data: [] }] }, code: "invalid_record_data" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const response = await post(testCase.body, secretA, `invalid-${index}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: testCase.code } });
    }
    expect(harness.d1Calls).toEqual([]);
    expect(harness.commands.get("database-a")?.size).toBe(0);
  });

  it("treats injection-looking text as a bound JSON value and makes raw SQL unrepresentable", async () => {
    harness = setup();
    const injection = "'); DROP TABLE mb_records; --";
    const response = await post({
      operations: [{ collection: "tasks", id: "safe-record", data: { note: injection } }],
    }, secretA, "bound-value-key");
    expect(response.status).toBe(200);
    expect(harness.d1Calls).toHaveLength(1);
    expect(harness.d1Calls[0].sql).not.toContain(injection);
    expect(JSON.stringify(harness.d1Calls[0].params)).toContain(injection);
    expect(harness.records.get("database-a")?.get("tasks")?.get("safe-record")?.data).toContain(injection);

    const rawSql = await post({
      operations: [{ collection: "tasks", id: "other", data: {} }],
      sql: "DELETE FROM mb_records",
    }, secretA, "raw-sql-key");
    expect(rawSql.status).toBe(400);
    expect(await rawSql.json()).toEqual({ error: { code: "invalid_command" } });
    expect(harness.d1Calls).toHaveLength(1);
  });

  it("fails closed if v6's trigger is missing, and preserves the generic transport error when the table is absent", async () => {
    harness = setup({
      projects: [{
        projectId: projectA,
        databaseId: "database-a",
        slug: "alpha",
        dataSchemaVersion: 5,
        schemaVersions: [1, 2, 3, 4, 5],
        commandTablePresent: true,
        commandTriggerPresent: false,
      }],
    });
    const incomplete = await post(twoOperations, secretA, "incomplete-v6");
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toEqual({ error: { code: "command_schema_not_ready" } });
    expect(harness.d1Calls).toHaveLength(1);
    expect(harness.records.get("database-a")?.size).toBe(0);
    expect(harness.commands.get("database-a")?.size).toBe(0);

    harness.dispose();
    harness = setup({
      projects: [{
        projectId: projectA,
        databaseId: "database-a",
        slug: "alpha",
        dataSchemaVersion: 5,
        schemaVersions: [1, 2, 3, 4, 5],
      }],
    });
    const noTable = await post(twoOperations, secretA, "no-table-v6");
    expect(noTable.status).toBe(502);
    expect(await noTable.json()).toEqual({ error: { code: "cloudflare_api_error" } });
    expect(harness.d1Calls).toHaveLength(1);
    expect(harness.records.get("database-a")?.size).toBe(0);
    expect(harness.commands.get("database-a")?.size).toBe(0);
  });

  it("does not create a false success marker on a pre-execution transport failure and safely retries", async () => {
    harness = setup({ failProjectD1Requests: 1 });
    const failed = await post(twoOperations, secretA, "transport-retry-key");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: { code: "cloudflare_api_error" } });
    expect(harness.d1Calls).toHaveLength(1);
    expect(harness.records.get("database-a")?.size).toBe(0);
    expect(harness.commands.get("database-a")?.size).toBe(0);

    const retried = await post(twoOperations, secretA, "transport-retry-key");
    expect(retried.status).toBe(200);
    expect((await retried.json() as { replayed: boolean }).replayed).toBe(false);
    expect(harness.d1Calls).toHaveLength(2);
    expect(harness.commands.get("database-a")?.size).toBe(1);
  });
});
