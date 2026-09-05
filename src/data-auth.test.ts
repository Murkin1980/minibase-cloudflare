import { describe, expect, it } from "vitest";
import type { MiniBaseEnv } from "./contracts";
import { authenticateDataKey, dataKeyDenialReason, keyActivityUpdateIsDue } from "./data-auth";
import { DEFAULT_LIMITS } from "./limits";
import type { ProjectQuotaRow } from "./project-quotas";

interface TestDataKeyRow extends ProjectQuotaRow {
  id: string;
  project_id: string;
  kind: "publishable" | "secret";
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
  d1_database_id: string;
  status: string;
  last_used_at: string | null;
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
  last_used_at: null,
  // CP-03: NULL quotas, i.e. the project inherits the deployment ceilings.
  quota_max_json_bytes: null,
  quota_max_file_bytes: null,
  quota_max_page_size: null,
  quota_max_bulk_records: null,
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

  it("fails closed on a project context that could escape interpolation", () => {
    // CP-03: `d1_database_id` becomes a segment of the Cloudflare REST path and
    // `project_id` becomes the R2 key prefix. Neither is a bound parameter, so a
    // corrupted control row is refused rather than used. Both report the same
    // reason as a missing database, so a caller cannot tell the cases apart.
    const now = new Date("2029-01-01T00:00:00Z");
    for (const d1_database_id of ["../elsewhere", "db/../../admin", "database-1?sql=SELECT", "database 1", "database-1%2F", ".."]) {
      expect(dataKeyDenialReason({ ...activeRow, d1_database_id }, "data:read", now), d1_database_id)
        .toBe("project_unavailable");
    }
    for (const project_id of ["../project-b", "project-1/../../other", "project 1", "project-1?x=1", ".."]) {
      expect(dataKeyDenialReason({ ...activeRow, project_id }, "data:read", now), project_id)
        .toBe("project_unavailable");
    }
    // The identities MiniBase actually issues are accepted.
    expect(dataKeyDenialReason({
      ...activeRow,
      project_id: "58e27c56-0374-4a3f-84c5-90dca9bfcb3e",
      d1_database_id: "22250945-ad19-44e4-a18f-9012983bd5f6",
    }, "data:read", now)).toBeNull();
  });

  it("resolves the project quota onto the authenticated principal", async () => {
    // The quota columns ride along on the authentication join, so the principal
    // is the single place a data-plane handler can read a ceiling from.
    const state = authEnv({
      ...activeRow,
      quota_max_json_bytes: 8192,
      quota_max_file_bytes: null,
      quota_max_page_size: 25,
      quota_max_bulk_records: null,
    });
    const principal = await authenticateDataKey(
      state.env,
      new Request("https://minibase.test/v1/data/lessons", {
        headers: { authorization: "Bearer mb_publishable_token" },
      }),
      "data:read",
    );
    expect(principal?.limits).toMatchObject({
      maxJsonBytes: 8192,
      maxPageSize: 25,
      defaultPageSize: 25,
      // Untouched by any quota: this sizes a write budget shared by every tenant.
      keyActivityIntervalMs: DEFAULT_LIMITS.keyActivityIntervalMs,
      maxFileBytes: DEFAULT_LIMITS.maxFileBytes,
      maxBulkRecords: DEFAULT_LIMITS.maxBulkRecords,
    });
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

  it("throttles key-activity writes without weakening the access decision", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const fiveMinutes = 5 * 60 * 1000;
    // Never used: record it.
    expect(keyActivityUpdateIsDue(null, now, fiveMinutes)).toBe(true);
    expect(keyActivityUpdateIsDue(undefined, now, fiveMinutes)).toBe(true);
    expect(keyActivityUpdateIsDue("not-a-date", now, fiveMinutes)).toBe(true);
    // Recently used: skip the write.
    expect(keyActivityUpdateIsDue("2026-09-03T11:59:00Z", now, fiveMinutes)).toBe(false);
    expect(keyActivityUpdateIsDue("2026-09-03T11:55:00Z", now, fiveMinutes)).toBe(true);
    // A stale future value must not suppress writes forever.
    expect(keyActivityUpdateIsDue("2027-01-01T00:00:00Z", now, fiveMinutes)).toBe(false);
    // The throttle never changes authorization: a revoked key is still denied.
    expect(dataKeyDenialReason({ ...activeRow, revoked_at: "2028-01-01" }, "data:read", now))
      .toBe("revoked");
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
