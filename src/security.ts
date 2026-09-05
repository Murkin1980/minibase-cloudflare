const encoder = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type MiniBaseKeyPrefix = "mb_publishable_" | "mb_secret_" | "mb_management_";

export function randomToken(prefix: MiniBaseKeyPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}${body}`;
}

/**
 * Shape of an identity MiniBase interpolates into a URL path or a storage key.
 *
 * Two values are interpolated rather than bound as parameters, because both are
 * addresses and not data: the project's D1 database UUID goes into the Cloudflare
 * REST path (`src/d1-http.ts`), and the project ID becomes the R2 key prefix
 * (`projectObjectKey`, `src/files-api.ts`).
 *
 * Neither ever comes from a request — both are read from the control plane during
 * authentication. Validating them anyway is the fail-closed half of CP-03 project
 * isolation: a hand-edited, truncated, or corrupted control row must not be able
 * to redirect the data plane to another Cloudflare API path or to escape the
 * `{projectId}/` object prefix into a neighbouring tenant.
 *
 * Dots are excluded from the character class, so `..` cannot be expressed at all,
 * and `/`, `?`, `#`, `%`, and whitespace are excluded, so no path or query
 * boundary can be injected. Canonical UUIDs — what MiniBase actually generates
 * and what Cloudflare returns — always satisfy it.
 */
const safeIdentityPattern = /^[A-Za-z0-9-]{1,64}$/;

export function isSafeIdentity(value: unknown): value is string {
  return typeof value === "string" && safeIdentityPattern.test(value);
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
