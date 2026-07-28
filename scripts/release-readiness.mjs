import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredDocs = [
  "docs/CLIENT_SDK.md",
  "docs/DATA_API.md",
  "docs/SECURITY.md",
  "docs/SUPABASE_MIGRATION.md",
  "docs/LAUNCH_RUNBOOK.md",
  "docs/PRODUCTION_DECISION.example.md",
];

export async function inspectReleaseReadiness(
  root = new URL("../", import.meta.url),
  configPath = "wrangler.jsonc",
) {
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
    productionConfig = await readFile(new URL(configPath, root), "utf8");
  } catch {
    issues.push(`owner_approval_required:${configPath}`);
  }
  if (/REPLACE_WITH|replace-with/i.test(productionConfig)) issues.push(`placeholder:${configPath}`);
  return {
    status: issues.length === 0 ? "ready" : "blocked",
    issues,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await inspectReleaseReadiness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === "ready" ? 0 : 2;
}
