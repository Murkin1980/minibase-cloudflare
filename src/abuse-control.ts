import type { MiniBaseEnv } from "./contracts";
import { sha256 } from "./security";

function routeClass(pathname: string): string {
  if (pathname.startsWith("/v1/data/")) return "data";
  if (pathname.startsWith("/v1/files")) return "files";
  return "control";
}

export async function abuseLimitKeys(request: Request): Promise<string[]> {
  const route = routeClass(new URL(request.url).pathname);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const keys = [`${route}:ip:${ip}`];
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    keys.push(`${route}:token:${await sha256(authorization.slice(7))}`);
  }
  return keys;
}

export async function requestIsAllowed(env: MiniBaseEnv, request: Request): Promise<boolean> {
  if (!env.RATE_LIMITER || request.method === "OPTIONS" || new URL(request.url).pathname === "/health") return true;
  for (const key of await abuseLimitKeys(request)) {
    const result = await env.RATE_LIMITER.limit({ key });
    if (!result.success) return false;
  }
  return true;
}
