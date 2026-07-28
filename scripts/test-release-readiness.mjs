import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { inspectReleaseReadiness } from "./release-readiness.mjs";

const result = await inspectReleaseReadiness();
assert.equal(result.status, "blocked");
assert.ok(result.issues.includes("owner_approval_required:wrangler.jsonc"));
assert.ok(!result.issues.some((issue) => issue.startsWith("missing:")));
const cli = spawnSync(process.execPath, ["scripts/release-readiness.mjs"], {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
});
assert.equal(cli.status, 2);
assert.match(cli.stdout, /"status": "blocked"/);
assert.match(cli.stdout, /owner_approval_required:wrangler\.jsonc/);
process.stdout.write("Release readiness gate correctly remains blocked pending owner approval\n");
