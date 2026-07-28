import { describe, expect, it, vi } from "vitest";
import { abuseLimitKey, requestIsAllowed } from "./abuse-control";
import type { MiniBaseEnv } from "./contracts";

describe("abuse control", () => {
  it("uses a token hash and route class without exposing the credential", async () => {
    const request = new Request("https://api.test/v1/data/lessons", {
      headers: { authorization: "Bearer mb_publishable_sensitive" },
    });
    const key = await abuseLimitKey(request);
    expect(key).toMatch(/^data:token:[a-f0-9]{64}$/);
    expect(key).not.toContain("sensitive");
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
});
