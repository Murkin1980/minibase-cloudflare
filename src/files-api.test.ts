import { describe, expect, it } from "vitest";
import { validateFilePath, validateUpload } from "./files-api";

describe("files API boundaries", () => {
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
