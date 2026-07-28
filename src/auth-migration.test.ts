import { describe, expect, it } from "vitest";
import {
  assertSafeAuthIdentityExport,
  findForbiddenAuthFields,
  sanitizeSupabaseAuthUser,
} from "./auth-migration";

const source = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  email: " User@Example.COM ",
  phone: null,
  email_confirmed_at: "2026-01-02T03:04:05Z",
  created_at: "2025-01-02T03:04:05Z",
  encrypted_password: "$2a$10$must-not-migrate",
  confirmation_token: "must-not-migrate",
  user_metadata: { role: "owner", recovery_token: "nested-secret" },
  app_metadata: { provider: "email", role: "admin" },
};

describe("Supabase Auth migration safety", () => {
  it("exports identity/contact fields without credential or authorization metadata", () => {
    const result = sanitizeSupabaseAuthUser(source, "password-reset");
    expect(result).toEqual({
      sourceUserId: source.id,
      email: "user@example.com",
      phone: null,
      confirmedAt: "2026-01-02T03:04:05.000Z",
      createdAt: "2025-01-02T03:04:05.000Z",
      requiredAction: "password-reset",
    });
    expect(findForbiddenAuthFields(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("$2a$");
  });

  it("detects forbidden material recursively", () => {
    expect(findForbiddenAuthFields(source)).toEqual(expect.arrayContaining([
      "encrypted_password", "confirmation_token", "user_metadata.recovery_token",
    ]));
    expect(() => assertSafeAuthIdentityExport({ ...source, access_token: "x" }))
      .toThrow("forbidden_auth_material");
  });

  it("requires a verified contact and valid strategy", () => {
    expect(() => sanitizeSupabaseAuthUser({ ...source, email: null }, "password-reset"))
      .toThrow("auth_identity_requires_contact");
  });
});
