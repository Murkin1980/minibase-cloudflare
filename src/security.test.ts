import { describe, expect, it } from "vitest";
import { managementKeyRecordIsAuthorized } from "./management-keys";
import { provisioningFingerprint } from "./provision";
import { randomToken } from "./security";
import { parseCreateDataKey, parseCreateManagementKey, parseCreateProject } from "./validation";

describe("MiniBase security contract", () => {
  it("creates distinct scoped key formats", () => {
    const publicKey = randomToken("mb_publishable_");
    const secretKey = randomToken("mb_secret_");
    const managementKey = randomToken("mb_management_");
    expect(publicKey).toMatch(/^mb_publishable_[a-f0-9]{64}$/);
    expect(secretKey).toMatch(/^mb_secret_[a-f0-9]{64}$/);
    expect(managementKey).toMatch(/^mb_management_[a-f0-9]{64}$/);
    expect(publicKey).not.toBe(secretKey);
  });

  it("enforces management scopes, expiry, and revocation", () => {
    const active = {
      id: "key-1",
      scopes: "projects:write,keys:write",
      expires_at: "2030-01-01T00:00:00Z",
      revoked_at: null,
    };
    expect(managementKeyRecordIsAuthorized(active, "projects:write", new Date("2029-01-01"))).toBe(true);
    expect(managementKeyRecordIsAuthorized(active, "audit:read", new Date("2029-01-01"))).toBe(false);
    expect(managementKeyRecordIsAuthorized(active, "projects:write", new Date("2031-01-01"))).toBe(false);
    expect(managementKeyRecordIsAuthorized(
      { ...active, revoked_at: "2028-01-01T00:00:00Z" },
      "projects:write",
      new Date("2029-01-01"),
    )).toBe(false);
  });

  it("validates project provisioning input", () => {
    expect(parseCreateProject({ slug: "tutor-kz", name: "1C Tutor" })).toEqual({
      slug: "tutor-kz",
      name: "1C Tutor",
    });
    expect(() => parseCreateProject({ slug: "../escape", name: "Bad" })).toThrow();
  });

  it("validates management key creation", () => {
    expect(parseCreateManagementKey({
      name: "automation",
      scopes: ["projects:write", "keys:write"],
    })).toEqual({
      name: "automation",
      scopes: ["projects:write", "keys:write"],
    });
    expect(() => parseCreateManagementKey({ name: "x", scopes: ["root"] })).toThrow();
  });

  it("binds idempotency to the canonical provisioning request", async () => {
    await expect(Promise.all([
      provisioningFingerprint({ slug: "tutor-kz", name: "Tutor", region: "apac" }),
      provisioningFingerprint({ name: "Tutor", region: "apac", slug: "tutor-kz" }),
    ])).resolves.toSatisfy(([left, right]) => left === right);
    await expect(Promise.all([
      provisioningFingerprint({ slug: "tutor-kz", name: "Tutor" }),
      provisioningFingerprint({ slug: "other", name: "Tutor" }),
    ])).resolves.toSatisfy(([left, right]) => left !== right);
  });

  it("restricts scopes by data-key kind", () => {
    expect(parseCreateDataKey({
      name: "browser",
      kind: "publishable",
      scopes: ["data:read"],
    })).toEqual({ name: "browser", kind: "publishable", scopes: ["data:read"] });
    expect(() => parseCreateDataKey({
      name: "browser",
      kind: "publishable",
      scopes: ["project:admin"],
    })).toThrow("invalid_scopes");
    expect(parseCreateDataKey({
      name: "backend",
      kind: "secret",
      scopes: ["project:admin"],
    }).kind).toBe("secret");
  });
});
