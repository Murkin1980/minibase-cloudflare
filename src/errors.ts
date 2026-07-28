const statusByCode: Record<string, number> = {
  unauthorized: 401,
  not_found: 404,
  management_key_not_found: 404,
  content_type_must_be_application_json: 415,
  request_body_too_large: 413,
  idempotency_key_reused_with_different_request: 409,
  cloudflare_api_error: 502,
};

const clientErrorCodes = new Set([
  "request_body_required",
  "invalid_json",
  "invalid_idempotency_key",
  "body_must_be_object",
  "invalid_slug",
  "invalid_name",
  "invalid_region",
  "invalid_scopes",
  "invalid_expiry",
  "invalid_rotation_source",
  "invalid_limit",
  "invalid_before",
  "active_key_self_revoke_forbidden",
]);

export function errorResponse(error: unknown, fallbackCode = "internal_error"): Response {
  const message = error instanceof Error ? error.message : fallbackCode;
  const knownCode = message in statusByCode || clientErrorCodes.has(message);
  const code = knownCode ? message : fallbackCode;
  const status = statusByCode[code] ?? (clientErrorCodes.has(code) ? 400 : 500);
  return Response.json(
    { error: { code } },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
