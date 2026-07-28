import { describe, expect, it } from "vitest";
import { compareFileInventories } from "./file-reconciliation";

describe("file reconciliation", () => {
  it("reports orphans and missing objects without mutation", () => {
    expect(compareFileInventories(
      ["a.pdf", "missing.txt", "shared.png"],
      ["a.pdf", "orphan.bin", "shared.png"],
    )).toEqual({
      orphanedObjects: ["orphan.bin"],
      missingObjects: ["missing.txt"],
    });
  });
});
