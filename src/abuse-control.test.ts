import { describe, expect, it, vi } from "vitest";
import {
  abuseLimitKeys,
  inspectProjectRequest,
  inspectRequest,
  projectLimitKey,
  projectRequestIsAllowed,
  rateLimiterFor,
  requestIsAllowed,
  routeClass,
} from "./abuse-control";
import type { MiniBaseEnv } from "./contracts";

describe("abuse control", () => {
  it("uses IP and token-hash ceilings without exposing the credential", async () => {
    const request = new Request("https://api.test/v1/data/lessons", {
      headers: {
        authorization: "Bearer mb_publishable_sensitive",
        "cf-connecting-ip": "192.0.2.10",
      },
    });
    const keys = await abuseLimitKeys(request);
    expect(keys).toEqual([
      "data:ip:192.0.2.10",
      expect.stringMatching(/^data:token:[a-f0-9]{64}$/),
    ]);
    expect(keys.join(",")).not.toContain("sensitive");
  });

  it("supports an optional binding and bypasses health/preflight", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = { RATE_LIMITER: { limit } } as unknown as MiniBaseEnv;
    await expect(requestIsAllowed(env, new Request("https://api.test/v1/files"))).resolves.toBe(false);
    await expect(requestIsAllowed(env, new Request("https://api.test/health"))).resolves.toBe(true);
    await expect(requestIsAllowed({} as MiniBaseEnv, new Request("https://api.test/v1/files")))
      .resolves.toBe(true);
    expect(limit).toHaveBeenCalledOnce();
  });

  it("applies one shared IP ceiling before distinct bearer buckets", async () => {
    const seen: string[] = [];
    const limit = vi.fn(async ({ key }: { key: string }) => {
      seen.push(key);
      return { success: true };
    });
    const env = { RATE_LIMITER: { limit } } as unknown as MiniBaseEnv;
    for (const token of ["mb_publishable_first", "mb_publishable_second"]) {
      await requestIsAllowed(env, new Request("https://api.test/v1/data/lessons", {
        headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "192.0.2.20" },
      }));
    }
    expect(seen.filter((key) => key === "data:ip:192.0.2.20")).toHaveLength(2);
    expect(new Set(seen.filter((key) => key.startsWith("data:token:"))).size).toBe(2);
  });
});

/**
 * CP-03: a Cloudflare rate-limit binding carries its own `limit` and `period`,
 * and `limit()` accepts only a key. Per-route periods are therefore declared as
 * one binding per route class, and per-project isolation as one bucket per
 * project inside that class.
 */
describe("per-route rate periods", () => {
  it("classifies every route into one of the three existing classes", () => {
    expect(routeClass("/v1/data/lessons")).toBe("data");
    expect(routeClass("/v1/data/lessons/rec-1")).toBe("data");
    expect(routeClass("/v1/files")).toBe("files");
    expect(routeClass("/v1/files/a/b.txt")).toBe("files");
    expect(routeClass("/v1/projects")).toBe("control");
    expect(routeClass("/v1/audit-events")).toBe("control");
    expect(routeClass("/v1/management-keys")).toBe("control");
  });

  it("prefers a per-route binding and falls back to the pre-CP-03 shared one", () => {
    const shared = { limit: vi.fn() };
    const data = { limit: vi.fn() };
    const env = (bindings: object) => bindings as unknown as MiniBaseEnv;
    // A deployment that declares only the legacy binding keeps its exact behaviour.
    expect(rateLimiterFor(env({ RATE_LIMITER: shared }), "data")).toBe(shared);
    expect(rateLimiterFor(env({ RATE_LIMITER: shared }), "control")).toBe(shared);
    // A declared per-route binding wins for its own class only.
    const both = env({ RATE_LIMITER: shared, RATE_LIMITER_DATA: data });
    expect(rateLimiterFor(both, "data")).toBe(data);
    expect(rateLimiterFor(both, "files")).toBe(shared);
    expect(rateLimiterFor(env({}), "control")).toBeUndefined();
  });

  it("consults only the binding that governs the route being served", async () => {
    const seen: string[] = [];
    const binding = (name: string) => ({
      async limit({ key }: { key: string }) {
        seen.push(`${name} <- ${key}`);
        return { success: true };
      },
    });
    const env = {
      RATE_LIMITER_CONTROL: binding("control"),
      RATE_LIMITER_DATA: binding("data"),
      RATE_LIMITER_FILES: binding("files"),
    } as unknown as MiniBaseEnv;
    const ip = { "cf-connecting-ip": "192.0.2.30" };
    await inspectRequest(env, new Request("https://api.test/v1/data/lessons", { headers: ip }));
    await inspectRequest(env, new Request("https://api.test/v1/files/a.txt", { headers: ip }));
    await inspectRequest(env, new Request("https://api.test/v1/projects", { headers: ip }));
    // One namespace each: a data-plane burst can no longer consume the control
    // plane's allowance, which is what the single shared namespace allowed.
    expect(seen).toEqual([
      "data <- data:ip:192.0.2.30",
      "files <- files:ip:192.0.2.30",
      "control <- control:ip:192.0.2.30",
    ]);
  });

  it("denies one route class without affecting the others", async () => {
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: !key.startsWith("data:") }));
    const env = { RATE_LIMITER: { limit } } as unknown as MiniBaseEnv;
    await expect(inspectRequest(env, new Request("https://api.test/v1/data/lessons"))).resolves.toBe("denied");
    await expect(inspectRequest(env, new Request("https://api.test/v1/files/a.txt"))).resolves.toBe("allowed");
    await expect(inspectRequest(env, new Request("https://api.test/v1/projects"))).resolves.toBe("allowed");
  });

  it("keeps health and preflight outside every period", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const env = { RATE_LIMITER: { limit }, MB_RATE_LIMITER_REQUIRED: "true" } as unknown as MiniBaseEnv;
    await expect(inspectRequest(env, new Request("https://api.test/health"))).resolves.toBe("allowed");
    await expect(inspectRequest(env, new Request("https://api.test/v1/data/lessons", { method: "OPTIONS" })))
      .resolves.toBe("allowed");
    expect(limit).not.toHaveBeenCalled();
  });

  it("fails closed when limiting is required but no binding resolves", async () => {
    // Without the switch, a deployment that loses its binding serves unlimited
    // traffic. With it, the request is refused instead.
    await expect(inspectRequest({} as MiniBaseEnv, new Request("https://api.test/v1/data/x")))
      .resolves.toBe("allowed");
    const required = { MB_RATE_LIMITER_REQUIRED: "true" } as unknown as MiniBaseEnv;
    await expect(inspectRequest(required, new Request("https://api.test/v1/data/x")))
      .resolves.toBe("unavailable");
    await expect(inspectProjectRequest(required, "data", "project-a")).resolves.toBe("unavailable");
    // A resolvable binding satisfies the requirement again.
    const satisfied = {
      MB_RATE_LIMITER_REQUIRED: "true",
      RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as MiniBaseEnv;
    await expect(inspectRequest(satisfied, new Request("https://api.test/v1/data/x")))
      .resolves.toBe("allowed");
    // Any value other than "true" leaves the historical behaviour untouched.
    for (const value of ["false", "1", "TRUE", ""]) {
      const env = { MB_RATE_LIMITER_REQUIRED: value } as unknown as MiniBaseEnv;
      await expect(inspectRequest(env, new Request("https://api.test/v1/data/x")))
        .resolves.toBe("allowed");
    }
  });

  it("keeps requestIsAllowed as the pre-CP-03 boolean contract", async () => {
    const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } } as unknown as MiniBaseEnv;
    await expect(requestIsAllowed(env, new Request("https://api.test/v1/data/x"))).resolves.toBe(false);
    // "unavailable" is not "allowed", so the boolean wrapper also fails closed.
    const required = { MB_RATE_LIMITER_REQUIRED: "true" } as unknown as MiniBaseEnv;
    await expect(requestIsAllowed(required, new Request("https://api.test/v1/data/x"))).resolves.toBe(false);
  });
});

describe("per-project rate buckets", () => {
  it("gives every project its own key inside its route class", () => {
    expect(projectLimitKey("data", "project-a")).toBe("data:project:project-a");
    expect(projectLimitKey("files", "project-b")).toBe("files:project:project-b");
    // The same project has a separate bucket per route class, so its periods are
    // independent too.
    expect(projectLimitKey("data", "project-a")).not.toBe(projectLimitKey("files", "project-a"));
  });

  it("denies one project without touching another", async () => {
    const exhausted = new Set(["project-a"]);
    const env = {
      RATE_LIMITER: {
        async limit({ key }: { key: string }) {
          return { success: !exhausted.has(key.split(":").at(-1) ?? "") };
        },
      },
    } as unknown as MiniBaseEnv;
    // This is the isolation property: one tenant exhausting its ceiling cannot
    // consume the account-wide D1 row quota every other tenant depends on.
    await expect(inspectProjectRequest(env, "data", "project-a")).resolves.toBe("denied");
    await expect(inspectProjectRequest(env, "data", "project-b")).resolves.toBe("allowed");
    await expect(projectRequestIsAllowed(env, "data", "project-b")).resolves.toBe(true);
  });

  it("routes a project bucket to the binding of its own route class", async () => {
    const seen: string[] = [];
    const binding = (name: string) => ({
      async limit({ key }: { key: string }) {
        seen.push(`${name} <- ${key}`);
        return { success: true };
      },
    });
    const env = {
      RATE_LIMITER_DATA: binding("data"),
      RATE_LIMITER_FILES: binding("files"),
      RATE_LIMITER: binding("shared"),
    } as unknown as MiniBaseEnv;
    await inspectProjectRequest(env, "data", "project-a");
    await inspectProjectRequest(env, "files", "project-a");
    await inspectProjectRequest(env, "control", "project-a");
    expect(seen).toEqual([
      "data <- data:project:project-a",
      "files <- files:project:project-a",
      "shared <- control:project:project-a",
    ]);
  });
});
