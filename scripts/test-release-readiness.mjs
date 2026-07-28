import assert from "node:assert/strict";
import { inspectReleaseReadiness } from "./release-readiness.mjs";

const result = await inspectReleaseReadiness();
assert.equal(result.status, "blocked");
assert.ok(result.issues.includes("owner_approval_required:wrangler.jsonc"));
assert.ok(!result.issues.some((issue) => issue.startsWith("missing:")));
process.stdout.write("Release readiness gate correctly remains blocked pending owner approval\n");
