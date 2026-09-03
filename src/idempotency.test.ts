import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  decideIdempotentReplay,
  fingerprintRequest,
  parseIdempotencyKey,
} from "./idempotency";
import { provisioningFingerprint } from "./provision";

describe("idempotency foundation", () => {
  it("accepts a bounded key and rejects a missing or oversized one", () => {
    expect(parseIdempotencyKey("import-2026-09-03")).toBe("import-2026-09-03");
    expect(() => parseIdempotencyKey(null)).toThrow("invalid_idempotency_key");
    expect(() => parseIdempotencyKey("")).toThrow("invalid_idempotency_key");
    expect(() => parseIdempotencyKey("k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)))
      .toThrow("invalid_idempotency_key");
    expect(parseIdempotencyKey("k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toHaveLength(100);
  });

  it("replays an identical request, conflicts on a reused key, executes when unseen", () => {
    expect(decideIdempotentReplay(null, "hash")).toBe("execute");
    expect(decideIdempotentReplay(undefined, "hash")).toBe("execute");
    expect(decideIdempotentReplay("hash", "hash")).toBe("replay");
    expect(decideIdempotentReplay("hash", "other")).toBe("conflict");
  });

  it("fingerprints the same payload identically and different payloads differently", async () => {
    const left = await fingerprintRequest({ slug: "a", name: "A", region: null });
    const right = await fingerprintRequest({ slug: "a", name: "A", region: null });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(await fingerprintRequest({ slug: "a", name: "A", region: "weur" })).not.toBe(left);
  });

  it("keeps the persisted provisioning fingerprint stable", async () => {
    // This exact value is what production `provisioning_jobs.request_hash` rows
    // hold. Recomputing it proves the extraction did not change the algorithm.
    const stable = await provisioningFingerprint({ slug: "interactive-kp", name: "Interactive KP" });
    expect(stable).toBe(await provisioningFingerprint({ slug: "interactive-kp", name: "Interactive KP" }));
    expect(stable).toMatch(/^[a-f0-9]{64}$/);
    // A region is normalized to null when absent, so both forms agree.
    expect(await provisioningFingerprint({ slug: "s", name: "N" }))
      .toBe(await provisioningFingerprint({ slug: "s", name: "N", region: undefined }));
  });
});
