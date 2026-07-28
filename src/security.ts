const encoder = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(prefix: "mb_publishable_" | "mb_secret_"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}${body}`;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function managementKeyIsValid(request: Request, expectedHash: string): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer mb_management_")) return false;
  return constantTimeHexEqual(await sha256(authorization.slice(7)), expectedHash);
}
