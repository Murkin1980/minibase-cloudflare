export interface MiniBaseRecord<T extends Record<string, unknown>> {
  id: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface MiniBaseList<T extends Record<string, unknown>> {
  records: MiniBaseRecord<T>[];
  /** Last cursor of this page. Always present while `records` is non-empty. */
  nextAfter: string | null;
  /**
   * Whether another page exists. Prefer this over testing `nextAfter` for null:
   * `nextAfter` is also returned on a short final page.
   */
  hasMore: boolean;
}

/* --------------------------------------------------- CP-04 query contract */

/**
 * The server's static allowlists, mirrored so the SDK cannot build a request
 * MiniBase would reject. These must stay in step with `src/record-query.ts`;
 * `src/client.test.ts` asserts that they do.
 */
export const filterOperators = {
  id: ["eq"],
  createdAt: ["eq", "gt", "gte", "lt", "lte"],
  updatedAt: ["eq", "gt", "gte", "lt", "lte"],
  schemaVersion: ["eq"],
} as const;

export const orderFieldNames = ["id", "createdAt", "updatedAt"] as const;
export const selectFieldNames = ["id", "data", "createdAt", "updatedAt"] as const;

export type MiniBaseFilterField = keyof typeof filterOperators;
export type MiniBaseOrderField = (typeof orderFieldNames)[number];
export type MiniBaseSelectField = (typeof selectFieldNames)[number];

type FilterValue<F extends MiniBaseFilterField> = F extends "schemaVersion" ? number : string;

export type MiniBaseFilter = {
  [F in MiniBaseFilterField]?: {
    [O in (typeof filterOperators)[F][number]]?: FilterValue<F>;
  };
};

export interface MiniBaseOrder {
  field: MiniBaseOrderField;
  direction?: "asc" | "desc";
}

export interface MiniBaseListOptions {
  limit?: number;
  /** The previous page's `nextAfter`, passed back unmodified. Opaque. */
  after?: string;
  filter?: MiniBaseFilter;
  order?: MiniBaseOrder;
  select?: MiniBaseSelectField[];
}

const cursorPattern = /^(mbq1\.[A-Za-z0-9_-]+|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

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
  if (!value.startsWith("mb_publishable_") && !value.startsWith("mb_secret_")) {
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

  /**
   * Lists a collection.
   *
   * The CP-04 options are typed against the server's allowlists, so a filter,
   * order, or select the Worker would reject with 400 does not compile — and a
   * call written before CP-04 keeps its exact previous behaviour, including the
   * bare record-ID cursor. `after` is deliberately typed as the opaque
   * `nextAfter` of the previous page; it is not a record ID once a filter or
   * order is in play, and must be passed back unmodified.
   */
  list<T extends Record<string, unknown>>(
    collection: string,
    options: MiniBaseListOptions = {},
  ): Promise<MiniBaseList<T>> {
    const path = this.collectionPath(collection);
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new Error("invalid_limit");
      }
      query.set("limit", String(options.limit));
    }
    for (const [field, condition] of Object.entries(options.filter ?? {})) {
      if (condition === undefined) continue;
      const operators = filterOperators[field as MiniBaseFilterField];
      for (const [operator, value] of Object.entries(condition as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (!(operators as readonly string[]).includes(operator)) throw new Error("invalid_operator");
        query.set(`filter[${field}${operator === "eq" ? "" : `.${operator}`}]`, String(value));
      }
    }
    if (options.order) {
      const { field, direction = "asc" } = options.order;
      if (!(orderFieldNames as readonly string[]).includes(field)) throw new Error("invalid_order");
      if (direction !== "asc" && direction !== "desc") throw new Error("invalid_order");
      query.set("order", `${field}.${direction}`);
    }
    if (options.select) {
      if (options.select.length === 0) throw new Error("invalid_select");
      for (const field of options.select) {
        if (!(selectFieldNames as readonly string[]).includes(field)) throw new Error("invalid_select");
      }
      query.set("select", [...new Set(options.select)].join(","));
    }
    if (options.after !== undefined) {
      // A legacy (unfiltered, unordered) cursor is still a record ID and is
      // validated as one; a CP-04 cursor is opaque and only shape-checked.
      const legacy = !options.order && !options.filter;
      if (legacy) {
        if (!recordIdPattern.test(options.after)) throw new Error("invalid_record_id");
      } else if (!cursorPattern.test(options.after)) {
        throw new Error("invalid_cursor");
      }
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
    hasMore: boolean;
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
