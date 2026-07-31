import { describe, expect, it } from "vitest";
import type { MiniBaseEnv } from "./contracts";
import { verifyAccessIdentity } from "./access-auth";

const base64url = (value: Uint8Array | string) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

describe("Cloudflare Access identity", () => {
  it("verifies issuer, audience, expiry, subject, key id, and signature", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const header = base64url(JSON.stringify({ alg: "RS256", kid: "test-key" }));
    const payload = base64url(JSON.stringify({
      iss: "https://team.cloudflareaccess.com",
      aud: ["app-aud"],
      exp: Math.floor(Date.now() / 1000) + 60,
      sub: "access-user-id",
    }));
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const assertion = `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const env = {
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "app-aud",
    } as MiniBaseEnv;
    const requestFetch = async () => Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
    await expect(verifyAccessIdentity(env, assertion, requestFetch)).resolves.toBe("access-user-id");
    await expect(verifyAccessIdentity({ ...env, ACCESS_AUD: "wrong" }, assertion, requestFetch))
      .rejects.toThrow("invalid_access_assertion");
  });
});
