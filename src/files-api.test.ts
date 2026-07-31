import { describe, expect, it } from "vitest";
import { ownerFilePrefix, physicalFilePath, validateFilePath, validateUpload } from "./files-api";

describe("files API boundaries", () => {
  it("isolates session files with a hashed owner prefix", () => {
    const principal = {
      keyId: "session",
      projectId: "project",
      databaseId: "db",
      kind: "publishable" as const,
      scopes: ["files:read"],
      subjectHash: "b".repeat(64),
    };
    expect(ownerFilePrefix(principal)).toBe(`u_${"b".repeat(64)}/`);
    expect(physicalFilePath(principal, "screens/a.png")).toBe(`u_${"b".repeat(64)}/screens/a.png`);
  });

  it("accepts safe nested paths and rejects traversal", () => {
    expect(validateFilePath("lessons/intro.pdf")).toBe("lessons/intro.pdf");
    expect(() => validateFilePath("../secret")).toThrow("invalid_file_path");
    expect(() => validateFilePath("a//b")).toThrow("invalid_file_path");
  });

  it("requires bounded upload lengths", () => {
    const valid = new Request("https://minibase.test/v1/files/a.txt", {
      method: "PUT",
      headers: { "content-length": "3", "content-type": "text/plain" },
      body: "abc",
    });
    expect(validateUpload(valid)).toEqual({ size: 3, contentType: "text/plain" });
    const missing = new Request("https://minibase.test/v1/files/a.txt", { method: "PUT", body: "abc" });
    missing.headers.delete("content-length");
    expect(() => validateUpload(missing)).toThrow("content_length_required");
  });
});
