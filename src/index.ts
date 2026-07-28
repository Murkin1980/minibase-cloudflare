import type { MiniBaseEnv } from "./contracts";
import { provisionProject } from "./provision";
import { managementKeyIsValid } from "./security";
import { parseCreateProject } from "./validation";

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

export default {
  async fetch(request: Request, env: MiniBaseEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "minibase", status: "ok", version: "0.1.0" });
    }
    if (request.method === "POST" && url.pathname === "/v1/projects") {
      if (!await managementKeyIsValid(request, env.MINIBASE_MANAGEMENT_KEY_HASH)) {
        return json({ error: "unauthorized" }, 401);
      }
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || idempotencyKey.length > 100) {
        return json({ error: "Требуется корректный Idempotency-Key." }, 400);
      }
      try {
        const input = parseCreateProject(await request.json());
        return json(await provisionProject(env, input, idempotencyKey), 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Неизвестная ошибка." }, 400);
      }
    }
    return json({ error: "not_found" }, 404);
  },
};
