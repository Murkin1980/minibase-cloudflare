import { describe, expect, it } from "vitest";
import { errorResponse } from "./errors";

describe("API error contract", () => {
  it.each([
    ["unauthorized", 401],
    ["request_body_too_large", 413],
    ["content_type_must_be_application_json", 415],
    ["idempotency_key_reused_with_different_request", 409],
    ["idempotency_conflict", 409],
    ["command_schema_not_ready", 409],
    ["bulk_limit_exceeded", 400],
    ["cloudflare_api_error", 502],
    ["invalid_slug", 400],
  ])("maps %s to %s", async (code, status) => {
    const response = errorResponse(new Error(code));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
  });

  it("does not expose unknown upstream messages", async () => {
    const response = errorResponse(new Error("secret upstream detail"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "internal_error" } });
  });
});
