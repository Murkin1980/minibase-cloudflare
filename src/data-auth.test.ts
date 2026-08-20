import { describe, expect, it } from "vitest";
import type { MiniBaseEnv } from "./contracts";
import { authenticateDataKey, dataKeyDenialReason } from "./data-auth";

interface TestDataKeyRow {
  id: string;
  project_id: string;
  kind: "publishable" | "secret";
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
  d1_database_id: string;
  status: string;
}

const activeRow: TestDataKeyRow = {
  id: "key-1",
  project_id: "project-1",
  kind: "publishable" as const,
  scopes: "data:read",
  expires_at: "2030-01-01T00:00:00Z",
  revoked_at: null,
  d1_database_id: "database-1",
  status: "active",
};

function authEnv(row: TestDataKeyRow | null) {
  const auditBindings: unknown[][] = [];
  let lastUsedUpdates = 0;
  const controlDb = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async first() { return sql.includes("FROM api_keys") ? row : null; },
        async all() { return { success: true, results: [] }; },
        async run() {
          if (sql.includes("INSERT INTO audit_events")) auditBindings.push(bindings);
          if (sql.includes("UPDATE api_keys SET last_used_at")) lastUsedUpdates += 1;
          return { success: true };
        },
      };
    },
    async batch() { return []; },
  };
  return {
    env: { CONTROL_DB: controlDb } as unknown as MiniBaseEnv,
    auditBindings,
    get lastUsedUpdates() { return lastUsedUpdates; },
  };
}

describe("data authentication audit", () => {
  it("classifies every known denial without exposing credentials", () => {
    const now = new Date("2029-01-01T00:00:00Z");
    expect(dataKeyDenialReason(null, "data:read", now)).toBe("unknown_key");
    expect(dataKeyDenialReason({ ...activeRow, revoked_at: "2028-01-01" }, "data:read", now)).toBe("revoked");
    expect(dataKeyDenialReason({ ...activeRow, expires_at: "2028-01-01" }, "data:read", now)).toBe("expired");
    expect(dataKeyDenialReason({ ...activeRow, status: "suspended" }, "data:read", now)).toBe("project_inactive");
    expect(dataKeyDenialReason({ ...activeRow, d1_database_id: "" }, "data:read", now)).toBe("project_unavailable");
    expect(dataKeyDenialReason(activeRow, "data:write", now)).toBe("scope");
  });

  it("audits an unknown key without storing the raw token", async () => {
    const state = authEnv(null);
    const rawToken = "mb_publishable_never-store-this-value";
    const principal = await authenticateDataKey(
      state.env,
      new Request("https://minibase.test/v1/data/lessons", {
        headers: { authorization: `Bearer ${rawToken}` },
      }),
      "data:read",
    );
    expect(principal).toBeNull();
    expect(state.auditBindings).toHaveLength(1);
    expect(JSON.stringify(state.auditBindings[0])).not.toContain(rawToken);
    expect(state.auditBindings[0]).toContain("denied");
    expect(state.auditBindings[0]).toContain('{"reason":"unknown_key","requiredScope":"data:read"}');
  });

  it("audits known-key denial and does not audit successful authentication", async () => {
    const denied = authEnv({ ...activeRow, revoked_at: "2028-01-01" });
    await authenticateDataKey(
      denied.env,
      new Request("https://minibase.test/v1/data/lessons", {
        headers: { authorization: "Bearer mb_publishable_revoked" },
      }),
      "data:read",
    );
    expect(denied.auditBindings[0]).toContain("key-1");
    expect(denied.auditBindings[0]).toContain("project-1");
    expect(denied.auditBindings[0]).toContain('{"reason":"revoked","requiredScope":"data:read"}');

    const allowed = authEnv({ ...activeRow, expires_at: "2099-01-01T00:00:00Z" });
    const principal = await authenticateDataKey(
      allowed.env,
      new Request("https://minibase.test/v1/data/lessons", {
        headers: { authorization: "Bearer mb_publishable_active" },
      }),
      "data:read",
    );
    expect(principal?.keyId).toBe("key-1");
    expect(allowed.auditBindings).toHaveLength(0);
    expect(allowed.lastUsedUpdates).toBe(1);
  });
});
