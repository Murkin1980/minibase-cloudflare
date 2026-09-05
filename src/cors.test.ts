import { describe, expect, it } from "vitest";
import { addCorsHeaders, normalizeOrigin, preflightResponse } from "./cors";
import { parseOrigins } from "./project-origins";

describe("project CORS policy", () => {
  it("normalizes secure and local origins", () => {
    expect(normalizeOrigin("https://Tutor.Example:443")).toBe("https://tutor.example");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => normalizeOrigin("http://example.com")).toThrow("insecure_origin");
    expect(() => normalizeOrigin("https://example.com/path")).toThrow("invalid_origin");
  });

  it("deduplicates and bounds configured origins", () => {
    expect(parseOrigins({ origins: ["https://example.com", "https://example.com/"] }))
      .toEqual(["https://example.com"]);
    expect(() => parseOrigins({ origins: new Array(21).fill("https://example.com") })).toThrow("invalid_origins");
  });

  it("adds origin-specific headers to allowed responses", () => {
    const request = new Request("https://api.test/v1/data/x", { headers: { origin: "https://app.test" } });
    const response = addCorsHeaders(Response.json({ ok: true }), request);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    expect(preflightResponse(request).status).toBe(204);
  });
});
