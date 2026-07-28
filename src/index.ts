import { listAuditEvents, parseAuditQuery } from "./audit";
import type { MiniBaseEnv } from "./contracts";
import { errorResponse } from "./errors";
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
      return json({ service: "minibase", status: "ok", version: "0.5.0" });
    }
    if (request.method === "POST" && url.pathname === "/v1/projects") {
      const actor = await authenticateManagementKey(env, request, "projects:write");
      if (!actor) return errorResponse(new Error("unauthorized"));
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || idempotencyKey.length > 100) {
        return errorResponse(new Error("invalid_idempotency_key"));
      }
      try {
        const input = parseCreateProject(await readJsonBounded(request));
        return json(await provisionProject(env, input, idempotencyKey, actor.keyId), 201);
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/management-keys") {
      const actor = await authenticateManagementKey(env, request, "keys:write");
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        return json(await createManagementKey(env, parseCreateManagementKey(await readJsonBounded(request)), actor), 201);
      } catch (error) {
        return errorResponse(error);
      }
    }
    const revokeMatch = url.pathname.match(/^\/v1\/management-keys\/([0-9a-f-]+)$/);
    if (request.method === "DELETE" && revokeMatch) {
      const actor = await authenticateManagementKey(env, request, "keys:write");
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        await revokeManagementKey(env, revokeMatch[1], actor);
        return new Response(null, { status: 204 });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/audit-events") {
      const actor = await authenticateManagementKey(env, request, "audit:read");
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        return json(await listAuditEvents(env, parseAuditQuery(url)));
      } catch (error) {
        return errorResponse(error);
      }
    }
    return errorResponse(new Error("not_found"));
  },
};
