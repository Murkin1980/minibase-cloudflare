import { describe, expect, it, vi } from "vitest";
import { abuseLimitKeys, requestIsAllowed } from "./abuse-control";
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
