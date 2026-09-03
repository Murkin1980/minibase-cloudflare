import { afterEach, describe, expect, it, vi } from "vitest";
import type { MiniBaseEnv } from "./contracts";
import { provisionProject, provisioningFingerprint } from "./provision";

/**
 * Provisioning idempotency is the only write path that already had an
 * `Idempotency-Key` contract. These tests pin the replay/conflict behaviour that
 * `src/idempotency.ts` now shares with future write commands.
 */

interface ExistingJob {
  project_id: string;
  status: string;
  request_hash: string | null;
  rollback_status: string | null;
}

function envWithJob(job: ExistingJob | null) {
  const cloudflareCalls: string[] = [];
  const controlDb = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const prepared = {
        bind(...bound: unknown[]) {
          values = bound;
          return prepared;
        },
        async first() {
          if (sql.includes("FROM provisioning_jobs")) return job;
          return null;
        },
        async all() {
          return { success: true, results: [] };
        },
        async run() {
          return { success: true, results: [] };
        },
      };
      void values;
      return prepared;
    },
    async batch() {
      return [];
    },
  };
  const env = { CONTROL_DB: controlDb } as unknown as MiniBaseEnv;
  return { env, cloudflareCalls };
}

afterEach(() => vi.unstubAllGlobals());

const input = { slug: "alpha-project", name: "Alpha Project" } as const;

describe("provisioning idempotency", () => {
  it("replays a stored job without touching Cloudflare again", async () => {
    const requestHash = await provisioningFingerprint(input);
    const { env } = envWithJob({
      project_id: "project-1",
      status: "active",
      request_hash: requestHash,
      rollback_status: "not_required",
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(provisionProject(env, input, "import-run-1", "management-key-1"))
      .resolves.toEqual({
        projectId: "project-1",
        status: "active",
        rollbackStatus: "not_required",
        replayed: true,
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces rollback status on a replayed failed job", async () => {
    const requestHash = await provisioningFingerprint(input);
    const { env } = envWithJob({
      project_id: "project-1",
      status: "failed",
      request_hash: requestHash,
      rollback_status: "completed",
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    await expect(provisionProject(env, input, "import-run-1", "management-key-1"))
      .resolves.toMatchObject({ status: "failed", rollbackStatus: "completed", replayed: true });
  });

  it("rejects a reused key that carries a different request", async () => {
    const { env } = envWithJob({
      project_id: "project-1",
      status: "active",
      request_hash: "f".repeat(64),
      rollback_status: "not_required",
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(provisionProject(env, input, "import-run-1", "management-key-1"))
      .rejects.toThrow("idempotency_key_reused_with_different_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a job stored before request hashing as replayable", async () => {
    // Legacy rows have a NULL request_hash; they replay rather than conflict.
    const { env } = envWithJob({
      project_id: "project-1",
      status: "active",
      request_hash: null,
      rollback_status: "not_required",
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    await expect(provisionProject(env, input, "import-run-1", "management-key-1"))
      .resolves.toMatchObject({ replayed: true });
  });
});
