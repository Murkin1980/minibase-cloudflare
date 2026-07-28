export interface MigratedIdentity {
  sourceUserId: string;
  email: string | null;
  phone: string | null;
  confirmedAt: string | null;
  createdAt: string;
  requiredAction: "password-reset" | "dual-auth-handoff";
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const forbiddenKeyPattern = /(password|token|secret|session|refresh|challenge|nonce|otp)/i;

export function findForbiddenAuthFields(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (forbiddenKeyPattern.test(key)) found.push(childPath);
    if (child && typeof child === "object") found.push(...findForbiddenAuthFields(child, childPath));
  }
  return found;
}

const optionalContact = (value: unknown, kind: "email" | "phone"): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 320) throw new Error(`invalid_auth_${kind}`);
  if (kind === "email") {
    const normalized = value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error("invalid_auth_email");
    return normalized;
  }
  const normalized = value.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) throw new Error("invalid_auth_phone");
  return normalized;
};

const timestamp = (value: unknown, required: boolean): string | null => {
  if ((value === null || value === undefined) && !required) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("invalid_auth_timestamp");
  return new Date(value).toISOString();
};

export function sanitizeSupabaseAuthUser(
  source: unknown,
  strategy: MigratedIdentity["requiredAction"],
): MigratedIdentity {
  if (!source || typeof source !== "object") throw new Error("invalid_auth_user");
  const user = source as Record<string, unknown>;
  if (typeof user.id !== "string" || !uuidPattern.test(user.id)) throw new Error("invalid_auth_user_id");
  if (strategy !== "password-reset" && strategy !== "dual-auth-handoff") throw new Error("invalid_auth_strategy");
  const identity: MigratedIdentity = {
    sourceUserId: user.id,
    email: optionalContact(user.email, "email"),
    phone: optionalContact(user.phone, "phone"),
    confirmedAt: timestamp(user.email_confirmed_at ?? user.phone_confirmed_at, false),
    createdAt: timestamp(user.created_at, true)!,
    requiredAction: strategy,
  };
  if (!identity.email && !identity.phone) throw new Error("auth_identity_requires_contact");
  return identity;
}

export function assertSafeAuthIdentityExport(value: unknown): void {
  const forbidden = findForbiddenAuthFields(value);
  if (forbidden.length > 0) throw new Error(`forbidden_auth_material:${forbidden.join(",")}`);
}
