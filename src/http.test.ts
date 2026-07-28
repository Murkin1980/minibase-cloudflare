import { describe, expect, it } from "vitest";
import { parseAuditQuery } from "./audit";
import { readJsonBounded } from "./http";

describe("HTTP boundaries", () => {
  it("reads a bounded JSON request", async () => {
    const request = new Request("https://minibase.test/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Tutor" }),
    });
    await expect(readJsonBounded(request, 100)).resolves.toEqual({ name: "Tutor" });
  });

  it("rejects oversized and incorrectly typed bodies", async () => {
    const oversized = new Request("https://minibase.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(100) }),
    });
    await expect(readJsonBounded(oversized, 20)).rejects.toThrow("request_body_too_large");
    const text = new Request("https://minibase.test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    await expect(readJsonBounded(text)).rejects.toThrow("content_type_must_be_application_json");
  });

  it("validates audit pagination", () => {
    expect(parseAuditQuery(new URL("https://minibase.test/v1/audit-events"))).toEqual({ limit: 50 });
    expect(parseAuditQuery(new URL("https://minibase.test/v1/audit-events?limit=10&before=2026-07-28T00:00:00Z")))
      .toEqual({ limit: 10, before: "2026-07-28T00:00:00Z" });
    expect(() => parseAuditQuery(new URL("https://minibase.test/v1/audit-events?limit=101"))).toThrow();
  });
});
