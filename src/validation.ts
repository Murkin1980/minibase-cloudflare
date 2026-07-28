import type { CreateProjectRequest } from "./contracts";

const slugPattern = /^[a-z][a-z0-9-]{2,39}$/;

export function parseCreateProject(value: unknown): CreateProjectRequest {
  if (!value || typeof value !== "object") throw new Error("Тело запроса должно быть объектом.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.slug !== "string" || !slugPattern.test(candidate.slug)) {
    throw new Error("slug: 3–40 символов, латиница, цифры и дефис.");
  }
  if (typeof candidate.name !== "string" || candidate.name.trim().length < 2 || candidate.name.length > 80) {
    throw new Error("name: от 2 до 80 символов.");
  }
  const region = candidate.region;
  if (region !== undefined && region !== "weur" && region !== "eeur" && region !== "apac") {
    throw new Error("region должен быть weur, eeur или apac.");
  }
  return { slug: candidate.slug, name: candidate.name.trim(), ...(region ? { region } : {}) };
}
