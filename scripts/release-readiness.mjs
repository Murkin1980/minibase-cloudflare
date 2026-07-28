import { access, readFile } from "node:fs/promises";

const requiredDocs = [
  "docs/CLIENT_SDK.md",
  "docs/DATA_API.md",
  "docs/SECURITY.md",
  "docs/SUPABASE_MIGRATION.md",
  "docs/LAUNCH_RUNBOOK.md",
  "docs/PRODUCTION_DECISION.example.md",
];

export async function inspectReleaseReadiness(root = new URL("../", import.meta.url)) {
  const issues = [];
  for (const path of requiredDocs) {
    try {
      await access(new URL(path, root));
    } catch {
      issues.push(`missing:${path}`);
    }
  }
  let productionConfig = "";
  try {
    productionConfig = await readFile(new URL("wrangler.jsonc", root), "utf8");
  } catch {
    issues.push("owner_approval_required:wrangler.jsonc");
  }
  if (/REPLACE_WITH|replace-with/i.test(productionConfig)) issues.push("placeholder:wrangler.jsonc");
  return {
    status: issues.length === 0 ? "ready" : "blocked",
    issues,
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await inspectReleaseReadiness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === "ready" ? 0 : 2;
}
