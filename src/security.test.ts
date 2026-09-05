import { describe, expect, it } from "vitest";
import { managementKeyRecordIsAuthorized } from "./management-keys";
import { initialPublishableKeyScopes, initialSecretKeyScopes } from "./key-scopes";
import { provisioningFingerprint } from "./provision";
import { isSafeIdentity, randomToken } from "./security";
import { parseCreateDataKey, parseCreateManagementKey, parseCreateProject } from "./validation";

describe("interpolated identity guard", () => {
  it("accepts the identities MiniBase actually issues", () => {
    // crypto.randomUUID() for projects, Cloudflare's D1 UUID for databases.
    expect(isSafeIdentity("58e27c56-0374-4a3f-84c5-90dca9bfcb3e")).toBe(true);
    expect(isSafeIdentity("22250945-ad19-44e4-a18f-9012983bd5f6")).toBe(true);
    expect(isSafeIdentity("database-a")).toBe(true);
  });

  it("rejects anything that could escape a URL path or a key prefix", () => {
    // Dots are excluded outright, so `..` cannot be expressed at all; path,
    // query, and fragment boundaries and whitespace are excluded too.
    for (const value of [
      "", "..", ".", "../elsewhere", "a/../../b", "a?x=1", "a#f", "a b", "a%2Fb",
      "a\\b", "a'b", 'a"b', "a;b", "a\nb", "\u0000", "x".repeat(65),
    ]) {
      expect(isSafeIdentity(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("rejects values that are not strings at all", () => {
    // A NULL or numeric control-plane column must not be coerced into an address.
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(isSafeIdentity(value)).toBe(false);
    }
  });
});

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
      last_used_at: null,
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
    expect(parseCreateProject({ slug: "1c-tutor-kz", name: "1C Tutor KZ" })).toEqual({
      slug: "1c-tutor-kz",
      name: "1C Tutor KZ",
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
    expect(initialPublishableKeyScopes).toEqual(["data:read", "files:read"]);
    expect(initialSecretKeyScopes).toEqual(["project:admin"]);
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
    expect(() => parseCreateDataKey({
      name: "browser writer",
      kind: "publishable",
      scopes: ["data:write"],
    })).toThrow("invalid_scopes");
    expect(() => parseCreateDataKey({
      name: "browser uploader",
      kind: "publishable",
      scopes: ["files:write"],
    })).toThrow("invalid_scopes");
    expect(parseCreateDataKey({
      name: "backend",
      kind: "secret",
      scopes: ["project:admin"],
    }).kind).toBe("secret");
    expect(parseCreateDataKey({
      name: "backend writer",
      kind: "secret",
      scopes: ["data:write", "files:write"],
    }).scopes).toEqual(["data:write", "files:write"]);
  });
});
