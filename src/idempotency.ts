import { sha256 } from "./security";

/**
 * Reusable idempotency primitive.
 *
 * Project provisioning already required an `Idempotency-Key` bound to the hash
 * of the normalized request. This module is that behaviour extracted verbatim so
 * future write commands (CP-05) reuse one definition instead of inventing a
 * second one.
 *
 * Contract:
 * - a retried request with the same key and the same fingerprint replays;
 * - the same key with a different fingerprint is a caller bug and is rejected;
 * - MiniBase never trusts the key alone: it always compares fingerprints.
 */

export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

export function parseIdempotencyKey(header: string | null): string {
  if (!header || header.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new Error("invalid_idempotency_key");
  }
  return header;
}

/**
 * Stable fingerprint of a normalized request payload.
 *
 * Key order must be fixed by the caller: JSON.stringify preserves insertion
 * order, so two callers must normalize identically or their hashes will differ.
 */
export async function fingerprintRequest(value: unknown): Promise<string> {
  return sha256(JSON.stringify(value));
}

export type IdempotentReplayDecision = "execute" | "replay" | "conflict";

/**
 * Decides what to do with a stored request for an idempotency key.
 *
 * `conflict` means the key was reused for a different request, which is always
 * rejected rather than silently replayed.
 */
export function decideIdempotentReplay(
  storedHash: string | null | undefined,
  requestHash: string,
): IdempotentReplayDecision {
  if (storedHash === null || storedHash === undefined) return "execute";
  return storedHash === requestHash ? "replay" : "conflict";
}
