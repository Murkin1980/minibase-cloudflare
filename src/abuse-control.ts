import type { MiniBaseEnv, RateLimiter } from "./contracts";
import { sha256 } from "./security";

/**
 * CP-03 abuse control: per-route periods and per-project buckets.
 *
 * Two independent dimensions were added to the route-class + IP + credential
 * limiting that already existed:
 *
 * 1. **Per-route periods.** A Cloudflare rate-limit binding carries its own
 *    `limit` and `period`; the `limit()` call supplies only a key. Separate
 *    periods for control, data, and files traffic are therefore declared as one
 *    binding per route class, and `rateLimiterFor` picks the right one. This
 *    closes the gap `docs/SECURITY.md` listed as a launch blocker: one namespace
 *    (production 22001, 120 calls / 60 s) previously covered every route, so a
 *    browser polling `/v1/data` could starve the control plane.
 *
 * 2. **Per-project buckets.** Once authentication has resolved a project, that
 *    project gets its own bucket. One noisy tenant then exhausts its own ceiling
 *    rather than the account-wide D1 row quota that every other tenant depends on
 *    — the shared-resource coupling `docs/SCALABILITY.md` §3 lists as risks 1
 *    and 2.
 *
 * Neither dimension is audited. A rate-limit denial storm would otherwise write
 * one control-D1 row per rejected request, consuming the same daily write quota
 * the limiting exists to protect.
 */

export type RouteClass = "control" | "data" | "files";

export function routeClass(pathname: string): RouteClass {
  if (pathname.startsWith("/v1/data/") || pathname.startsWith("/v1/commands/")) return "data";
  if (pathname.startsWith("/v1/files")) return "files";
  return "control";
}

/**
 * Binding that governs one route class.
 *
 * Resolution order is the class binding, then the pre-CP-03 shared `RATE_LIMITER`.
 * Keeping the shared binding as the fallback is what makes CP-03 backward
 * compatible: an already-deployed Worker with a single namespace behaves exactly
 * as before until the owner approves separate ones.
 */
export function rateLimiterFor(env: MiniBaseEnv, route: RouteClass): RateLimiter | undefined {
  const perRoute = {
    control: env.RATE_LIMITER_CONTROL,
    data: env.RATE_LIMITER_DATA,
    files: env.RATE_LIMITER_FILES,
  }[route];
  return perRoute ?? env.RATE_LIMITER;
}

/**
 * Whether a deployment that demands rate limiting can actually enforce it.
 *
 * Opt-in through `MB_RATE_LIMITER_REQUIRED`, so local development and tests —
 * which legitimately declare no binding — are unaffected. When it is on, losing a
 * binding must fail closed rather than silently serve unlimited traffic.
 */
export function rateLimiterIsRequired(env: MiniBaseEnv): boolean {
  return env.MB_RATE_LIMITER_REQUIRED === "true";
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

/**
 * Pre-authentication limiting: route class + client IP, plus a SHA-256 credential
 * identity when one is present.
 *
 * Returns `"allowed"`, `"denied"`, or `"unavailable"` when limiting is required
 * but no binding could be resolved for the route class.
 */
export async function inspectRequest(
  env: MiniBaseEnv,
  request: Request,
): Promise<"allowed" | "denied" | "unavailable"> {
  const pathname = new URL(request.url).pathname;
  if (request.method === "OPTIONS" || pathname === "/health") return "allowed";
  const route = routeClass(pathname);
  const limiter = rateLimiterFor(env, route);
  if (!limiter) return rateLimiterIsRequired(env) ? "unavailable" : "allowed";
  for (const key of await abuseLimitKeys(request)) {
    const result = await limiter.limit({ key });
    if (!result.success) return "denied";
  }
  return "allowed";
}

/**
 * The pre-CP-03 boolean contract, kept because callers that only need to know
 * "may this request proceed" should not have to learn the three-valued form.
 * Note that it maps "unavailable" to `false`: a deployment that demands rate
 * limiting and cannot enforce it fails closed either way.
 */
export async function requestIsAllowed(env: MiniBaseEnv, request: Request): Promise<boolean> {
  return await inspectRequest(env, request) === "allowed";
}

/**
 * Project-scoped rate-limit key.
 *
 * The project ID comes from the authenticated principal, never from the request,
 * and has already passed `isSafeIdentity`, so it cannot inject a key boundary and
 * cannot collide with another tenant's bucket.
 */
export function projectLimitKey(route: RouteClass, projectId: string): string {
  return `${route}:project:${projectId}`;
}

/**
 * Post-authentication limiting: one bucket per project per route class.
 *
 * Runs before the origin lookup, which is itself a control-D1 read, so a project
 * that has exhausted its ceiling stops consuming control-plane capacity at that
 * point rather than after it.
 *
 * `"unavailable"` is reported separately from `"denied"` so the caller can answer
 * a missing binding with 503 rather than pretending the project is rate limited.
 */
export async function inspectProjectRequest(
  env: MiniBaseEnv,
  route: RouteClass,
  projectId: string,
): Promise<"allowed" | "denied" | "unavailable"> {
  const limiter = rateLimiterFor(env, route);
  if (!limiter) return rateLimiterIsRequired(env) ? "unavailable" : "allowed";
  const result = await limiter.limit({ key: projectLimitKey(route, projectId) });
  return result.success ? "allowed" : "denied";
}

export async function projectRequestIsAllowed(
  env: MiniBaseEnv,
  route: RouteClass,
  projectId: string,
): Promise<boolean> {
  return await inspectProjectRequest(env, route, projectId) === "allowed";
}
