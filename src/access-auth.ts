import type { MiniBaseEnv } from "./contracts";

interface AccessPayload {
  aud?: string | string[];
  exp?: number;
  iss?: string;
  sub?: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const decodeJson = <T>(value: string): T =>
  JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;

const audienceMatches = (audience: string | string[] | undefined, expected: string) =>
  typeof audience === "string" ? audience === expected : audience?.includes(expected) === true;

export async function verifyAccessIdentity(
  env: MiniBaseEnv,
  assertion: string,
  requestFetch: typeof fetch = fetch,
): Promise<string> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error("access_not_configured");
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Error("invalid_access_assertion");
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]);
  const payload = decodeJson<AccessPayload>(parts[1]);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (
    header.alg !== "RS256" ||
    !header.kid ||
    payload.iss !== issuer ||
    !audienceMatches(payload.aud, env.ACCESS_AUD) ||
    !payload.sub ||
    !payload.exp ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) throw new Error("invalid_access_assertion");

  const response = await requestFetch(`${issuer}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("access_keys_unavailable");
  const keys = await response.json() as { keys?: Jwk[] };
  const jwk = keys.keys?.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error("invalid_access_assertion");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new Error("invalid_access_assertion");
  return payload.sub;
}
