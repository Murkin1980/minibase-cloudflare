import type { CreateManagementKeyRequest, CreateProjectRequest } from "./contracts";

const slugPattern = /^[a-z][a-z0-9-]{2,39}$/;
const managementScopes = new Set(["projects:write", "keys:write", "audit:read"]);

export function parseCreateProject(value: unknown): CreateProjectRequest {
  if (!value || typeof value !== "object") throw new Error("body_must_be_object");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.slug !== "string" || !slugPattern.test(candidate.slug)) {
    throw new Error("invalid_slug");
  }
  if (typeof candidate.name !== "string" || candidate.name.trim().length < 2 || candidate.name.length > 80) {
    throw new Error("invalid_name");
  }
  const region = candidate.region;
  if (region !== undefined && region !== "weur" && region !== "eeur" && region !== "apac") {
    throw new Error("invalid_region");
  }
  return { slug: candidate.slug, name: candidate.name.trim(), ...(region ? { region } : {}) };
}

export function parseCreateManagementKey(value: unknown): CreateManagementKeyRequest {
  if (!value || typeof value !== "object") throw new Error("body_must_be_object");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length < 2 || candidate.name.length > 80) {
    throw new Error("invalid_name");
  }
  if (
    !Array.isArray(candidate.scopes) ||
    candidate.scopes.length === 0 ||
    candidate.scopes.some((scope) => typeof scope !== "string" || !managementScopes.has(scope))
  ) {
    throw new Error("invalid_scopes");
  }
  if (
    candidate.expiresAt !== undefined &&
    (typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt)) ||
      new Date(candidate.expiresAt) <= new Date())
  ) {
    throw new Error("invalid_expiry");
  }
  if (candidate.rotateFromKeyId !== undefined && typeof candidate.rotateFromKeyId !== "string") {
    throw new Error("invalid_rotation_source");
  }
  return {
    name: candidate.name.trim(),
    scopes: [...new Set(candidate.scopes as string[])],
    ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt as string } : {}),
    ...(candidate.rotateFromKeyId ? { rotateFromKeyId: candidate.rotateFromKeyId as string } : {}),
  };
}
