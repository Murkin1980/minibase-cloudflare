import type { MiniBaseEnv } from "./contracts";
import { sha256 } from "./security";

function routeClass(pathname: string): string {
  if (pathname.startsWith("/v1/data/")) return "data";
  if (pathname.startsWith("/v1/files")) return "files";
  return "control";
}

export async function abuseLimitKey(request: Request): Promise<string> {
  const authorization = request.headers.get("authorization");
  const identity = authorization?.startsWith("Bearer ")
    ? `token:${await sha256(authorization.slice(7))}`
    : `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
  return `${routeClass(new URL(request.url).pathname)}:${identity}`;
}

export async function requestIsAllowed(env: MiniBaseEnv, request: Request): Promise<boolean> {
  if (!env.RATE_LIMITER || request.method === "OPTIONS" || new URL(request.url).pathname === "/health") return true;
  const result = await env.RATE_LIMITER.limit({ key: await abuseLimitKey(request) });
  return result.success;
}
