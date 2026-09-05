import type { MiniBaseEnv } from "./contracts";
import { queryProjectD1 } from "./d1-http";
import { ARTIFACT_PREFIX } from "./artifacts";

export function compareFileInventories(metadataPaths: string[], objectPaths: string[]) {
  const metadata = new Set(metadataPaths);
  const objects = new Set(objectPaths);
  return {
    orphanedObjects: [...objects].filter((path) => !metadata.has(path)).sort(),
    missingObjects: [...metadata].filter((path) => !objects.has(path)).sort(),
  };
}

export function compareArtifactInventories(
  metadata: Array<{ artifactId: string; storageKey: string; size: number; etag: string }>,
  objects: Array<{ key: string; size: number; etag: string }>,
  projectId: string,
) {
  const metaByKey = new Map<string, { artifactId: string; size: number; etag: string }>();
  for (const row of metadata) metaByKey.set(row.storageKey, { artifactId: row.artifactId, size: row.size, etag: row.etag });

  const objByKey = new Map<string, { size: number; etag: string }>();
  for (const obj of objects) objByKey.set(obj.key, { size: obj.size, etag: obj.etag });

  const orphanedArtifacts: string[] = [];
  const missingArtifacts: string[] = [];
  const sizeMismatches: Array<{ artifactId: string; storageKey: string }> = [];
  const etagMismatches: Array<{ artifactId: string; storageKey: string }> = [];

  for (const [key, obj] of objByKey) {
    const meta = metaByKey.get(key);
    if (!meta) orphanedArtifacts.push(key.slice(`${projectId}/`.length));
    else {
      if (meta.size !== obj.size) sizeMismatches.push({ artifactId: meta.artifactId, storageKey: key });
      if (meta.etag !== obj.etag) etagMismatches.push({ artifactId: meta.artifactId, storageKey: key });
    }
  }
  for (const [key, meta] of metaByKey) {
    if (!objByKey.has(key)) missingArtifacts.push(meta.artifactId);
  }

  return {
    orphanedArtifacts: orphanedArtifacts.sort(),
    missingArtifacts: missingArtifacts.sort(),
    sizeMismatches,
    etagMismatches,
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
  // Filter out artifact keys from file reconcile — they belong to separate namespace
  const fileObjects = listed.objects.filter((o) => !o.key.includes(`/${ARTIFACT_PREFIX}`));
  const comparison = compareFileInventories(
    metadata.results.map((row) => row.path),
    fileObjects.map((object) => object.key.slice(prefix.length)),
  );
  return {
    projectId,
    scannedMetadata: metadata.results.length,
    scannedObjects: fileObjects.length,
    truncated: listed.truncated,
    ...comparison,
  };
}

export async function reconcileProjectArtifacts(env: MiniBaseEnv, projectId: string) {
  const project = await env.CONTROL_DB.prepare(
    "SELECT d1_database_id FROM projects WHERE id = ? AND status = 'active'",
  ).bind(projectId).first<{ d1_database_id: string }>();
  if (!project?.d1_database_id) throw new Error("project_not_found");

  // If v7 not applied, treat as schema not ready
  let artifactRows: Array<{ artifact_id: string; storage_key: string; size: number; etag: string; checksum_sha256: string; uploaded_at: string; entity_type: string | null; entity_id: string | null }> = [];
  let hasTable = true;
  try {
    const result = await queryProjectD1<{
      artifact_id: string; storage_key: string; size: number; etag: string; checksum_sha256: string; uploaded_at: string; entity_type: string | null; entity_id: string | null;
    }>(
      env,
      project.d1_database_id,
      "SELECT artifact_id, storage_key, size, etag, checksum_sha256, uploaded_at, entity_type, entity_id FROM mb_artifacts ORDER BY artifact_id LIMIT 1000",
      [],
    );
    artifactRows = result.results as typeof artifactRows;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("no such table: mb_artifacts") || msg.includes("no such table")) {
      hasTable = false;
    } else {
      throw error;
    }
  }

  const prefix = `${projectId}/${ARTIFACT_PREFIX}`;
  const listed = await env.FILES.list({ prefix, limit: 1000 });
  // Also detect legacy files with NULL checksum/uploaded_at as informational
  let legacyFiles: string[] = [];
  try {
    const legacy = await queryProjectD1<{ path: string }>(
      env,
      project.d1_database_id,
      "SELECT path FROM mb_files WHERE checksum_sha256 IS NULL OR uploaded_at IS NULL ORDER BY path LIMIT 1000",
      [],
    );
    legacyFiles = legacy.results.map((r) => r.path);
  } catch {
    // v6 fallback — all files are legacy
    legacyFiles = [];
  }

  if (!hasTable) {
    return {
      projectId,
      artifactTableReady: false,
      scannedArtifacts: 0,
      scannedObjects: listed.objects.length,
      orphanedArtifacts: listed.objects.map((o) => o.key.slice(`${projectId}/`.length)).sort(),
      missingArtifacts: [],
      sizeMismatches: [],
      etagMismatches: [],
      legacyFilesWithNullChecksum: legacyFiles,
      truncated: listed.truncated,
    };
  }

  const metaForCompare = artifactRows.map((r) => ({
    artifactId: r.artifact_id,
    storageKey: r.storage_key,
    size: r.size,
    etag: r.etag,
  }));
  const objForCompare = listed.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag }));
  const cmp = compareArtifactInventories(metaForCompare, objForCompare, projectId);

  // Detect malformed metadata
  const malformedArtifacts: string[] = [];
  for (const row of artifactRows) {
    if (!/^[a-f0-9]{64}$/.test(row.checksum_sha256) || !row.uploaded_at || !row.etag) {
      malformedArtifacts.push(row.artifact_id);
    }
  }

  return {
    projectId,
    artifactTableReady: true,
    scannedArtifacts: artifactRows.length,
    scannedObjects: listed.objects.length,
    truncated: listed.truncated,
    ...cmp,
    malformedArtifacts: malformedArtifacts.sort(),
    legacyFilesWithNullChecksum: legacyFiles,
  };
}
