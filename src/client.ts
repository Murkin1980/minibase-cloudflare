export interface MiniBaseRecord<T extends Record<string, unknown>> {
  id: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface MiniBaseList<T extends Record<string, unknown>> {
  records: MiniBaseRecord<T>[];
  nextAfter: string | null;
}

export class MiniBaseClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "MiniBaseClientError";
  }
}

export interface MiniBaseClientOptions {
  baseUrl: string;
  key: string;
  fetch?: typeof fetch;
}

const collectionPattern = /^[a-z][a-z0-9_-]{1,62}$/;
const recordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const filePathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("insecure_base_url");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("invalid_base_url");
  return url.toString().replace(/\/+$/, "");
}

function validateKey(value: string): string {
  if (
    !value.startsWith("mb_publishable_") &&
    !value.startsWith("mb_secret_") &&
    !value.startsWith("mb_session_")
  ) {
    throw new Error("invalid_client_key");
  }
  return value;
}

async function parseError(response: Response): Promise<never> {
  let code = `http_${response.status}`;
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
  } catch {
    // Preserve the status-derived code for non-JSON proxy failures.
  }
  throw new MiniBaseClientError(code, response.status);
}

export class MiniBaseClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly requestFetch: typeof fetch;

  constructor(options: MiniBaseClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.key = validateKey(options.key);
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) return parseError(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private filePath(path: string): string {
    if (!filePathPattern.test(path) || path.includes("..") || path.includes("//") || path.endsWith("/")) {
      throw new Error("invalid_file_path");
    }
    return path.split("/").map(encodeURIComponent).join("/");
  }

  private collectionPath(collection: string, id?: string): string {
    if (!collectionPattern.test(collection)) throw new Error("invalid_collection");
    if (id !== undefined && !recordIdPattern.test(id)) throw new Error("invalid_record_id");
    return `/v1/data/${encodeURIComponent(collection)}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;
  }

  exchangeAccessSession(): Promise<{ token: string; expiresAt: string }> {
    if (!this.key.startsWith("mb_publishable_")) throw new Error("session_exchange_requires_publishable_key");
    return this.request("/v1/sessions/exchange", { method: "POST" });
  }

  endSession(): Promise<void> {
    if (!this.key.startsWith("mb_session_")) throw new Error("session_required");
    return this.request("/v1/sessions/current", { method: "DELETE" });
  }

  list<T extends Record<string, unknown>>(
    collection: string,
    options: { limit?: number; after?: string } = {},
  ): Promise<MiniBaseList<T>> {
    const path = this.collectionPath(collection);
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new Error("invalid_limit");
      }
      query.set("limit", String(options.limit));
    }
    if (options.after !== undefined) {
      if (!recordIdPattern.test(options.after)) throw new Error("invalid_record_id");
      query.set("after", options.after);
    }
    return this.request(`${path}${query.size ? `?${query}` : ""}`);
  }

  get<T extends Record<string, unknown>>(collection: string, id: string): Promise<MiniBaseRecord<T>> {
    return this.request(this.collectionPath(collection, id));
  }

  put<T extends Record<string, unknown>>(
    collection: string,
    id: string,
    data: T,
  ): Promise<{ id: string; data: T; updatedAt: string }> {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_record_data");
    return this.request(this.collectionPath(collection, id), {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  delete(collection: string, id: string): Promise<void> {
    return this.request(this.collectionPath(collection, id), { method: "DELETE" });
  }

  listFiles(options: { limit?: number; after?: string } = {}): Promise<{
    files: Array<{ path: string; size: number; contentType: string | null; etag: string; createdAt: string; updatedAt: string }>;
    nextAfter: string | null;
  }> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("invalid_limit");
      query.set("limit", String(options.limit));
    }
    if (options.after !== undefined) query.set("after", this.filePath(options.after));
    return this.request(`/v1/files${query.size ? `?${query}` : ""}`);
  }

  async downloadFile(path: string): Promise<Response> {
    const response = await this.requestFetch(`${this.baseUrl}/v1/files/${this.filePath(path)}`, {
      headers: { authorization: `Bearer ${this.key}` },
    });
    if (!response.ok) return parseError(response);
    return response;
  }

  uploadFile(path: string, body: Blob): Promise<{
    path: string; size: number; contentType: string; etag: string; updatedAt: string;
  }> {
    return this.request(`/v1/files/${this.filePath(path)}`, {
      method: "PUT",
      body,
      headers: {
        "content-type": body.type || "application/octet-stream",
        "content-length": String(body.size),
      },
    });
  }

  deleteFile(path: string): Promise<void> {
    return this.request(`/v1/files/${this.filePath(path)}`, { method: "DELETE" });
  }
}
