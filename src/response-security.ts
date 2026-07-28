const requestIdPattern = /^[A-Za-z0-9._:-]{8,100}$/;

export function resolveRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  return supplied && requestIdPattern.test(supplied) ? supplied : crypto.randomUUID();
}

export function hardenResponse(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-minibase-request-id", requestId);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
