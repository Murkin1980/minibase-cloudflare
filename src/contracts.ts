import type { LimitOverrides, MiniBaseLimits } from "./limits";

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  body?: ReadableStream;
  writeHttpMetadata(headers: Headers): void;
}

export interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  put(
    key: string,
    value: ReadableStream,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * A Cloudflare Workers rate-limiting binding.
 *
 * `limit` and `period` belong to the **binding**, not to the call: `limit()`
 * accepts only a key. Per-route periods are therefore declared as one binding per
 * route class in `wrangler.jsonc`, never passed as arguments.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface MiniBaseEnv extends LimitOverrides {
  CONTROL_DB: D1Database;
  FILES: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_D1_API_TOKEN: string;
  /**
   * Pre-CP-03 single namespace. Still honoured as the fallback for every route
   * class, so a deployment that declares only this binding keeps its exact
   * previous behaviour.
   */
  RATE_LIMITER?: RateLimiter;
  /**
   * CP-03 per-route periods: one optional binding per route class, each carrying
   * its own `limit` and `period`. A class whose binding is absent falls back to
   * `RATE_LIMITER`.
   */
  RATE_LIMITER_CONTROL?: RateLimiter;
  RATE_LIMITER_DATA?: RateLimiter;
  RATE_LIMITER_FILES?: RateLimiter;
  /**
   * Opt-in fail-closed switch. When `"true"`, a rate-limited route whose binding
   * cannot be resolved is refused with 503 `rate_limiter_unavailable` instead of
   * being served unlimited. Off by default so local development and tests, which
   * legitimately declare no binding, are unaffected.
   */
  MB_RATE_LIMITER_REQUIRED?: string;
}

export interface ManagementPrincipal {
  keyId: string;
  scopes: string[];
}

export interface DataPrincipal {
  keyId: string;
  projectId: string;
  databaseId: string;
  kind: "publishable" | "secret";
  scopes: string[];
  /**
   * CP-03: the ceilings this project is actually served under — the deployment
   * limits from `src/limits.ts`, tightened by its own quota row.
   *
   * Carried on the principal rather than looked up per call so that no data-plane
   * handler can accidentally reach for the deployment ceiling and serve a project
   * above its quota. Resolving it costs nothing extra: the quota columns are read
   * by the same `api_keys JOIN projects` query that authenticates the key.
   *
   * `projectId` and `databaseId` are guaranteed to satisfy `isSafeIdentity`
   * (`src/security.ts`) by the time a principal exists, because both are
   * interpolated into an R2 key prefix and a Cloudflare REST path respectively.
   */
  limits: MiniBaseLimits;
}

export interface D1HttpQueryResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
}

export interface CreateManagementKeyRequest {
  name: string;
  scopes: string[];
  expiresAt?: string;
  rotateFromKeyId?: string;
}

export interface CreateDataKeyRequest {
  name: string;
  kind: "publishable" | "secret";
  scopes: string[];
  expiresAt?: string;
  rotateFromKeyId?: string;
}

export interface CreateProjectRequest {
  slug: string;
  name: string;
  region?: "weur" | "eeur" | "apac";
}

export interface CloudflareD1 {
  uuid: string;
  name: string;
}

export interface CloudflareResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ message: string }>;
}
