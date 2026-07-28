import type { MiniBaseEnv } from "./contracts";
import { listAuditEvents, parseAuditQuery } from "./audit";
import { readJsonBounded } from "./http";
import {
  authenticateManagementKey,
  createManagementKey,
  revokeManagementKey,
} from "./management-keys";
import { provisionProject } from "./provision";
import { parseCreateManagementKey, parseCreateProject } from "./validation";

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

export default {
  async fetch(request: Request, env: MiniBaseEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "minibase", status: "ok", version: "0.3.0" });
    }
    if (request.method === "POST" && url.pathname === "/v1/projects") {
      const actor = await authenticateManagementKey(env, request, "projects:write");
      if (!actor) return json({ error: "unauthorized" }, 401);
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || idempotencyKey.length > 100) {
        return json({ error: "A valid Idempotency-Key is required." }, 400);
      }
      try {
        const input = parseCreateProject(await readJsonBounded(request));
        return json(await provisionProject(env, input, idempotencyKey, actor.keyId), 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/management-keys") {
      const actor = await authenticateManagementKey(env, request, "keys:write");
      if (!actor) return json({ error: "unauthorized" }, 401);
      try {
        return json(await createManagementKey(env, parseCreateManagementKey(await readJsonBounded(request)), actor), 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
      }
    }
    const revokeMatch = url.pathname.match(/^\/v1\/management-keys\/([0-9a-f-]+)$/);
    if (request.method === "DELETE" && revokeMatch) {
      const actor = await authenticateManagementKey(env, request, "keys:write");
      if (!actor) return json({ error: "unauthorized" }, 401);
      try {
        await revokeManagementKey(env, revokeMatch[1], actor);
        return new Response(null, { status: 204 });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/audit-events") {
      const actor = await authenticateManagementKey(env, request, "audit:read");
      if (!actor) return json({ error: "unauthorized" }, 401);
      try {
        return json(await listAuditEvents(env, parseAuditQuery(url)));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid_request" }, 400);
      }
    }
    return json({ error: "not_found" }, 404);
  },
};
