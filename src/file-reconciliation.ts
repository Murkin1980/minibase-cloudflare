import type { MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";

export function compareFileInventories(metadataPaths: string[], objectPaths: string[]) {
  const metadata = new Set(metadataPaths);
  const objects = new Set(objectPaths);
  return {
    orphanedObjects: [...objects].filter((path) => !metadata.has(path)).sort(),
    missingObjects: [...metadata].filter((path) => !objects.has(path)).sort(),
  };
}

export async function reconcileProjectFiles(env: MiniBaseEnv, projectId: string) {
  const project = await env.CONTROL_DB.prepare(
    "SELECT d1_database_id FROM projects WHERE id = ? AND status = 'active'",
  ).bind(projectId).first<{ d1_database_id: string }>();
  if (!project?.d1_database_id) throw new Error("project_not_found");
  const metadata = await queryProjectD1<{ path: string }>(
    env, project.d1_database_id, "SELECT path FROM mb_files ORDER BY path LIMIT 1000", [],
  );
  const prefix = `${projectId}/`;
  const listed = await env.FILES.list({ prefix, limit: 1000 });
  const comparison = compareFileInventories(
    metadata.results.map((row) => row.path),
    listed.objects.map((object) => object.key.slice(prefix.length)),
  );
  return {
    projectId,
    scannedMetadata: metadata.results.length,
    scannedObjects: listed.objects.length,
    truncated: listed.truncated,
    ...comparison,
  };
}
