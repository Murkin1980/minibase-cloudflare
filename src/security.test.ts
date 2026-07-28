import { describe, expect, it } from "vitest";
import { managementKeyIsValid, randomToken, sha256 } from "./security";
import { parseCreateProject } from "./validation";

describe("MiniBase security contract", () => {
  it("creates distinct scoped key formats", () => {
    const publicKey = randomToken("mb_publishable_");
    const secretKey = randomToken("mb_secret_");
    expect(publicKey).toMatch(/^mb_publishable_[a-f0-9]{64}$/);
    expect(secretKey).toMatch(/^mb_secret_[a-f0-9]{64}$/);
    expect(publicKey).not.toBe(secretKey);
  });

  it("accepts only the hashed management bearer key", async () => {
    const key = "mb_management_test-only-key";
    const request = new Request("https://minibase.test/v1/projects", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(await managementKeyIsValid(request, await sha256(key))).toBe(true);
    expect(await managementKeyIsValid(request, await sha256("wrong"))).toBe(false);
    expect(await managementKeyIsValid(request, `${await sha256(key)}00`)).toBe(false);
  });

  it("validates project provisioning input", () => {
    expect(parseCreateProject({ slug: "tutor-kz", name: "1C Tutor" })).toEqual({
      slug: "tutor-kz",
      name: "1C Tutor",
    });
    expect(() => parseCreateProject({ slug: "../escape", name: "Bad" })).toThrow();
  });
});
