import type { DataPrincipal } from "./contracts";

/**
 * Centralized builders/validators for file vs artifact keys.
 *
 * File keys:    {projectId}/{path}  where path ∈ ValidFilePath
 * Artifact keys:{projectId}/.mb_artifacts/originals/{artifactId}
 *
 * The first char of ValidFilePath is [A-Za-z0-9], so ".mb_artifacts/..." can never
 * be produced by a validated file path — file handlers physically cannot address
 * the artifact namespace even without an extra string check. The additional
 * explicit check below is defense-in-depth and makes the invariant grep-able.
 */

export const ARTIFACT_PREFIX = ".mb_artifacts/originals/";
export const ARTIFACT_R2_PREFIX = ".mb_artifacts/originals/";

// Artifact ID: 1..64, starts alnum, then alnum . _ -  (no slash, no colon)
const artifactIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Entity patterns reuse record validation
const collectionPattern = /^[a-z][a-z0-9_-]{1,62}$/; // 2..63
const recordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/; // 1..128

export function validateArtifactId(value: string): string {
  if (!artifactIdPattern.test(value)) throw new Error("invalid_artifact_id");
  return value;
}

export interface EntityLink {
  entityType: string;
  entityId: string;
}

export function parseEntityLink(
  rawType: string | null,
  rawId: string | null,
): EntityLink | null {
  const hasType = rawType !== null && rawType !== "";
  const hasId = rawId !== null && rawId !== "";
  if (!hasType && !hasId) return null;
  if (hasType !== hasId) throw new Error("invalid_entity_link");
  const entityType = rawType!;
  const entityId = rawId!;
  if (!collectionPattern.test(entityType) || entityType.startsWith("mb_")) {
    throw new Error("invalid_entity_link");
  }
  if (!recordIdPattern.test(entityId)) throw new Error("invalid_entity_link");
  return { entityType, entityId };
}

export function parseEntityHeaders(request: Request): EntityLink | null {
  // Spec: optional entity via documented headers. Accept both
  // x-minibase-entity-* (canonical) and x-entity-* alias.
  const rawType =
    request.headers.get("x-minibase-entity-type") ??
    request.headers.get("x-entity-type") ??
    request.headers.get("x-artifact-entity-type");
  const rawId =
    request.headers.get("x-minibase-entity-id") ??
    request.headers.get("x-entity-id") ??
    request.headers.get("x-artifact-entity-id");
  // Also support lowercase? Headers.get is case-insensitive per spec.
  // Normalize: treat empty string as null.
  const type = rawType && rawType.trim() !== "" ? rawType.trim().slice(0, 200) : null;
  const id = rawId && rawId.trim() !== "" ? rawId.trim().slice(0, 200) : null;
  return parseEntityLink(type, id);
}

/** Centralized artifact R2 key builder — projectId only from principal. */
export function artifactObjectKey(principal: DataPrincipal, artifactId: string): string {
  validateArtifactId(artifactId);
  return `${principal.projectId}/${ARTIFACT_PREFIX}${artifactId}`;
}

/** For file keys, ensure they never collide with artifact namespace. */
export function assertFilePathNotArtifact(path: string): void {
  if (path.startsWith(".mb_artifacts/") || path.includes("/.mb_artifacts/") || path === ".mb_artifacts") {
    throw new Error("invalid_file_path");
  }
}
