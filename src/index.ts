import { listAuditEvents, parseAuditQuery } from "./audit";
import type { MiniBaseEnv } from "./contracts";
import { addCorsHeaders, dataOriginIsAllowed, preflightResponse } from "./cors";
import {
  deleteRecord,
  getRecord,
  listRecords,
  parseRecordListQuery,
  putRecord,
  validateCollection,
  validateRecordData,
  validateRecordId,
} from "./data-api";
import { authenticateDataKey } from "./data-auth";
import { createDataKey, listDataKeys, revokeDataKey } from "./data-keys";
import { errorResponse } from "./errors";
import { parseIdempotencyKey } from "./idempotency";
import { resolveLimits } from "./limits";
import { deleteFile, downloadFile, listFiles, uploadFile, validateFilePath } from "./files-api";
import { reconcileProjectFiles } from "./file-reconciliation";
import { readJsonBounded } from "./http";
import {
  authenticateManagementKey,
  createManagementKey,
  revokeManagementKey,
} from "./management-keys";
import { provisionProject } from "./provision";
import { applyProjectSchema, verifyProjectSchema } from "./project-schema";
import { parseOrigins, replaceProjectOrigins } from "./project-origins";
import { parseCreateDataKey, parseCreateManagementKey, parseCreateProject } from "./validation";
import { hardenResponse, resolveRequestId } from "./response-security";
import { inspectProjectRequest, inspectRequest } from "./abuse-control";
import { parseProjectQuotas, readProjectQuotas, replaceProjectQuotas } from "./project-quotas";

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

const application = {
  async fetch(request: Request, env: MiniBaseEnv, correlationId: string): Promise<Response> {
    const url = new URL(request.url);
    const limits = resolveLimits(env);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "minibase", status: "ok", version: "0.26.0" });
    }
    if (request.method === "OPTIONS" && /^\/v1\/(data\/|files(?:\/|$))/.test(url.pathname)) {
      return preflightResponse(request);
    }
    if (request.method === "POST" && url.pathname === "/v1/projects") {
      const actor = await authenticateManagementKey(env, request, "projects:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        const idempotencyKey = parseIdempotencyKey(request.headers.get("idempotency-key"));
        const input = parseCreateProject(await readJsonBounded(request, limits.maxJsonBytes));
        return json(await provisionProject(env, input, idempotencyKey, actor.keyId), 201);
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/management-keys") {
      const actor = await authenticateManagementKey(env, request, "keys:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        return json(await createManagementKey(env, parseCreateManagementKey(await readJsonBounded(request, limits.maxJsonBytes)), actor), 201);
      } catch (error) {
        return errorResponse(error);
      }
    }
    const revokeMatch = url.pathname.match(/^\/v1\/management-keys\/([0-9a-f-]+)$/);
    if (request.method === "DELETE" && revokeMatch) {
      const actor = await authenticateManagementKey(env, request, "keys:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        await revokeManagementKey(env, revokeMatch[1], actor);
        return new Response(null, { status: 204 });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/audit-events") {
      const actor = await authenticateManagementKey(env, request, "audit:read", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        return json(await listAuditEvents(env, parseAuditQuery(url, limits)));
      } catch (error) {
        return errorResponse(error);
      }
    }
    const originsMatch = url.pathname.match(/^\/v1\/projects\/([0-9a-f-]+)\/origins$/);
    if (request.method === "PUT" && originsMatch) {
      const actor = await authenticateManagementKey(env, request, "projects:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        const origins = parseOrigins(await readJsonBounded(request, limits.maxJsonBytes));
        await replaceProjectOrigins(env, originsMatch[1], origins, actor);
        return json({ projectId: originsMatch[1], origins });
      } catch (error) {
        return errorResponse(error);
      }
    }
    // CP-03 per-project quotas. Same shape as the origins route it sits beside:
    // management-scoped, project-scoped, atomically audited. `GET` reports both
    // the stored quota and the ceiling the Worker will actually enforce, which is
    // what a consumer needs in order to stay inside its own project's budget.
    const quotasMatch = url.pathname.match(/^\/v1\/projects\/([0-9a-f-]+)\/quotas$/);
    if (quotasMatch) {
      const actor = await authenticateManagementKey(env, request, "projects:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      const projectId = quotasMatch[1];
      try {
        if (request.method === "GET") return json(await readProjectQuotas(env, projectId, limits));
        if (request.method === "PUT") {
          const quotas = parseProjectQuotas(await readJsonBounded(request, limits.maxJsonBytes));
          return json(await replaceProjectQuotas(env, projectId, quotas, actor, correlationId, limits));
        }
        return errorResponse(new Error("not_found"));
      } catch (error) {
        return errorResponse(error);
      }
    }
    const projectKeysMatch = url.pathname.match(/^\/v1\/projects\/([0-9a-f-]+)\/keys(?:\/([0-9a-f-]+))?$/);
    if (projectKeysMatch) {
      const actor = await authenticateManagementKey(env, request, "keys:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      const projectId = projectKeysMatch[1];
      const keyId = projectKeysMatch[2];
      try {
        if (request.method === "GET" && !keyId) return json(await listDataKeys(env, projectId));
        if (request.method === "POST" && !keyId) {
          return json(await createDataKey(
            env, projectId, parseCreateDataKey(await readJsonBounded(request, limits.maxJsonBytes)), actor,
          ), 201);
        }
        if (request.method === "DELETE" && keyId) {
          await revokeDataKey(env, projectId, keyId, actor);
          return new Response(null, { status: 204 });
        }
        return errorResponse(new Error("not_found"));
      } catch (error) {
        return errorResponse(error);
      }
    }
    const schemaMatch = url.pathname.match(/^\/v1\/projects\/([0-9a-f-]+)\/schema(?:\/(apply|verify))?$/);
    if (schemaMatch) {
      const actor = await authenticateManagementKey(env, request, "projects:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      const projectId = schemaMatch[1];
      const action = schemaMatch[2] ?? "verify";
      try {
        if (request.method === "POST" && action === "apply") {
          return json(await applyProjectSchema(env, projectId, actor.keyId, correlationId));
        }
        if (request.method === "GET" && (action === "verify" || !schemaMatch[2])) {
          return json(await verifyProjectSchema(env, projectId));
        }
        return errorResponse(new Error("not_found"));
      } catch (error) {
        return errorResponse(error);
      }
    }
    const reconcileMatch = url.pathname.match(/^\/v1\/projects\/([0-9a-f-]+)\/files\/reconcile$/);
    if (request.method === "GET" && reconcileMatch) {
      const actor = await authenticateManagementKey(env, request, "projects:write", correlationId);
      if (!actor) return errorResponse(new Error("unauthorized"));
      try {
        return json(await reconcileProjectFiles(env, reconcileMatch[1]));
      } catch (error) {
        return errorResponse(error);
      }
    }
    const dataMatch = url.pathname.match(/^\/v1\/data\/([^/]+)(?:\/([^/]+))?$/);
    if (dataMatch) {
      try {
        const collection = validateCollection(decodeURIComponent(dataMatch[1]));
        const id = dataMatch[2] ? validateRecordId(decodeURIComponent(dataMatch[2])) : null;
        const requiredScope = request.method === "GET" ? "data:read" : "data:write";
        const principal = await authenticateDataKey(env, request, requiredScope, correlationId, limits);
        if (!principal) return errorResponse(new Error("unauthorized"));
        // Per-project bucket. The pre-authentication gate has already resolved a
        // limiter for this same route class, so "unavailable" is defensive here —
        // it is handled rather than assumed away, so the data plane cannot serve
        // unlimited traffic if that gate is ever reordered.
        const projectRate = await inspectProjectRequest(env, "data", principal.projectId);
        if (projectRate === "unavailable") return errorResponse(new Error("rate_limiter_unavailable"));
        if (projectRate === "denied") return errorResponse(new Error("rate_limited"));
        if (!await dataOriginIsAllowed(env, principal.projectId, request)) {
          return errorResponse(new Error("origin_not_allowed"));
        }
        const cors = (response: Response) => addCorsHeaders(response, request);
        // Every ceiling below is the project's own, not the deployment's.
        const projectLimits = principal.limits;
        if (request.method === "GET" && id) return cors(json(await getRecord(env, principal, collection, id)));
        if (request.method === "GET" && !id) {
          return cors(json(await listRecords(env, principal, collection, parseRecordListQuery(url, collection, projectLimits))));
        }
        if (request.method === "PUT" && id) {
          return cors(json(await putRecord(
            env,
            principal,
            collection,
            id,
            validateRecordData(await readJsonBounded(request, projectLimits.maxJsonBytes)),
          )));
        }
        if (request.method === "DELETE" && id) {
          await deleteRecord(env, principal, collection, id);
          return cors(new Response(null, { status: 204 }));
        }
        return errorResponse(new Error("not_found"));
      } catch (error) {
        return errorResponse(error);
      }
    }
    const fileMatch = url.pathname.match(/^\/v1\/files(?:\/(.+))?$/);
    if (fileMatch) {
      try {
        const path = fileMatch[1] ? validateFilePath(decodeURIComponent(fileMatch[1])) : null;
        const requiredScope = request.method === "GET" ? "files:read" : "files:write";
        const principal = await authenticateDataKey(env, request, requiredScope, correlationId, limits);
        if (!principal) return errorResponse(new Error("unauthorized"));
        // Per-project bucket; "unavailable" is defensive, as on the data route.
        const projectRate = await inspectProjectRequest(env, "files", principal.projectId);
        if (projectRate === "unavailable") return errorResponse(new Error("rate_limiter_unavailable"));
        if (projectRate === "denied") return errorResponse(new Error("rate_limited"));
        if (!await dataOriginIsAllowed(env, principal.projectId, request)) {
          return errorResponse(new Error("origin_not_allowed"));
        }
        const cors = (response: Response) => addCorsHeaders(response, request);
        // Every ceiling below is the project's own, not the deployment's.
        const projectLimits = principal.limits;
        if (request.method === "GET" && !path) return cors(json(await listFiles(env, principal, url, projectLimits)));
        if (request.method === "GET" && path) return cors(await downloadFile(env, principal, path));
        if (request.method === "PUT" && path) {
          return cors(json(await uploadFile(env, principal, path, request, projectLimits), 201));
        }
        if (request.method === "DELETE" && path) {
          await deleteFile(env, principal, path);
          return cors(new Response(null, { status: 204 }));
        }
        return errorResponse(new Error("not_found"));
      } catch (error) {
        return errorResponse(error);
      }
    }
    return errorResponse(new Error("not_found"));
  },
};

export default {
  async fetch(request: Request, env: MiniBaseEnv): Promise<Response> {
    const requestId = resolveRequestId(request);
    try {
      const preAuth = await inspectRequest(env, request);
      if (preAuth === "unavailable") {
        return hardenResponse(errorResponse(new Error("rate_limiter_unavailable")), requestId);
      }
      if (preAuth === "denied") {
        return hardenResponse(errorResponse(new Error("rate_limited")), requestId);
      }
      return hardenResponse(await application.fetch(request, env, requestId), requestId);
    } catch {
      return hardenResponse(errorResponse(new Error("internal_error")), requestId);
    }
  },
};
