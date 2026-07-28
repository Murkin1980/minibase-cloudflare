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

export interface MiniBaseEnv {
  CONTROL_DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_D1_API_TOKEN: string;
}

export interface ManagementPrincipal {
  keyId: string;
  scopes: string[];
}

export interface CreateManagementKeyRequest {
  name: string;
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
