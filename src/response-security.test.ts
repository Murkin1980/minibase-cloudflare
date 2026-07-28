import { describe, expect, it } from "vitest";
import { hardenResponse, resolveRequestId } from "./response-security";

describe("response security middleware", () => {
  it("preserves safe caller correlation IDs and rejects injected values", () => {
    expect(resolveRequestId(new Request("https://api.test", {
      headers: { "x-request-id": "client-request:123" },
    }))).toBe("client-request:123");
    expect(resolveRequestId(new Request("https://api.test", {
      headers: { "x-request-id": "bad value" },
    }))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("adds policy headers without buffering a streaming body", async () => {
    const source = new Response("payload", {
      headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store" },
    });
    const result = hardenResponse(source, "request-123");
    expect(result.headers.get("x-minibase-request-id")).toBe("request-123");
    expect(result.headers.get("x-frame-options")).toBe("DENY");
    expect(result.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.text()).toBe("payload");
  });
});
