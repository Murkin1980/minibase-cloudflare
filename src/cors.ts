import type { MiniBaseEnv } from "./contracts";

export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_origin");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash) {
    throw new Error("invalid_origin");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("insecure_origin");
  }
  return url.origin;
}

export async function dataOriginIsAllowed(
  env: MiniBaseEnv,
  projectId: string,
  request: Request,
): Promise<boolean> {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    return false;
  }
  const row = await env.CONTROL_DB.prepare(
    "SELECT 1 AS allowed FROM project_origins WHERE project_id = ? AND origin = ?",
  ).bind(projectId, normalized).first<{ allowed: number }>();
  return Boolean(row);
}

export function addCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get("origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflightResponse(request: Request): Response {
  return addCorsHeaders(new Response(null, { status: 204 }), request);
}
