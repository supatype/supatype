import { AuthClient } from "./auth.js"
import { QueryBuilder, MutationBuilder } from "./query.js"
import { StorageClient } from "./storage.js"
import { RealtimeClient } from "./realtime.js"
import { PostgrestError } from "./errors.js"
import { createRetryFetch } from "./retry.js"
import { warnIfServerlessDirectConnection } from "./fetch-with-retry.js"
import type { AnyDatabase, FunctionDef, RpcResult, SupatypeClientConfig, SupatypeError } from "./types.js"

export type {
  User,
  Session,
  AuthChangeEvent,
  SupatypeError,
  QueryResult,
  RpcResult,
  AnyDatabase,
  SupatypeClientConfig,
  FunctionDef,
  TableDef,
} from "./types.js"
export { AuthClient } from "./auth.js"
export { QueryBuilder, MutationBuilder } from "./query.js"
export { StorageClient, BucketClient } from "./storage.js"
export type { StorageObject, TransformOptions } from "./storage.js"
export { RealtimeClient } from "./realtime.js"
export type { RealtimeEvent, RealtimePayload, ChannelStatus, PresenceEntry } from "./realtime.js"
export * from "./errors.js"
export { fetchWithRetry, detectServerlessEnvironment, warnIfServerlessDirectConnection } from "./fetch-with-retry.js"
export type { FetchOptions, ServerlessDetectionResult } from "./fetch-with-retry.js"
export { createRetryFetch } from "./retry.js"
export type { RetryConfig } from "./retry.js"
export { ERROR_CODES_DOCUMENTATION, getErrorDocumentation, getErrorCodesByCategory } from "./error-codes-doc.js"
export type { ErrorCodeEntry } from "./error-codes-doc.js"
export { CONNECTION_MODES, SERVERLESS_CONNECTION_WARNING, CONNECTION_FAQ } from "./serverless-docs.js"
export type { ConnectionModeDoc } from "./serverless-docs.js"

// ─── Table client ─────────────────────────────────────────────────────────────

interface TableDef {
  Row: Record<string, unknown>
  Insert: Record<string, unknown>
  Update: Record<string, unknown>
}

class TableClient<TDef extends TableDef> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly headers: Record<string, string>

  constructor(baseUrl: string, table: string, headers: Record<string, string>) {
    this.baseUrl = baseUrl
    this.path = `/rest/v1/${table}`
    this.headers = headers
  }

  /**
   * Start a SELECT query.
   *
   * Pass a type parameter to narrow the result when embedding relations:
   * ```ts
   * client.from('posts').select<Post & { comments: Comment[] }>('*, comments(*)')
   * ```
   * Without a type parameter the full Row type is returned.
   */
  select<TResult = TDef["Row"]>(columns?: string | undefined): QueryBuilder<TResult> {
    return new QueryBuilder<TResult>(this.baseUrl, this.path, this.headers, columns)
  }

  insert(
    data: TDef["Insert"] | TDef["Insert"][],
  ): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.headers,
      "POST",
      data,
    )
  }

  upsert(
    data: TDef["Insert"] | TDef["Insert"][],
  ): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.headers,
      "POST",
      data,
      { upsert: true },
    )
  }

  update(data: TDef["Update"]): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.headers,
      "PATCH",
      data,
    )
  }

  delete(): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.headers,
      "DELETE",
    )
  }
}

// ─── Main client ──────────────────────────────────────────────────────────────

export interface GlobalClient<TRow extends Record<string, unknown> = Record<string, unknown>> {
  get(): Promise<{ data: TRow | null; error: SupatypeError | null }>
  update(data: Partial<TRow>): Promise<{ data: TRow | null; error: SupatypeError | null }>
}

/**
 * Helper type: extract function names from a database type.
 * Falls back to `string` when Functions is not defined.
 */
type FunctionNames<TDatabase extends AnyDatabase> =
  TDatabase["public"] extends { Functions: infer F }
    ? F extends Record<string, FunctionDef>
      ? keyof F & string
      : string
    : string

/**
 * Helper type: extract the Args type for a named function.
 * Falls back to `Record<string, unknown>` when not typed.
 */
type FunctionArgs<TDatabase extends AnyDatabase, TFn extends string> =
  TDatabase["public"] extends { Functions: infer F }
    ? F extends Record<string, FunctionDef>
      ? TFn extends keyof F
        ? F[TFn]["Args"]
        : Record<string, unknown>
      : Record<string, unknown>
    : Record<string, unknown>

/**
 * Helper type: extract the Returns type for a named function.
 * Falls back to `unknown` when not typed.
 */
type FunctionReturns<TDatabase extends AnyDatabase, TFn extends string> =
  TDatabase["public"] extends { Functions: infer F }
    ? F extends Record<string, FunctionDef>
      ? TFn extends keyof F
        ? F[TFn]["Returns"]
        : unknown
      : unknown
    : unknown

// ─── Functions client ─────────────────────────────────────────────────────────

export interface FunctionInvokeOptions {
  /** HTTP method. Default: POST */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined
  /** Request headers (merged with defaults) */
  headers?: Record<string, string> | undefined
  /** Request body (JSON-serialisable) */
  body?: unknown | undefined
}

class FunctionsClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly doFetch: (url: string, init?: RequestInit) => Promise<Response>

  constructor(baseUrl: string, headers: Record<string, string>, doFetch: (url: string, init?: RequestInit) => Promise<Response>) {
    this.baseUrl = baseUrl
    this.headers = headers
    this.doFetch = doFetch
  }

  /**
   * Invoke an edge function by name.
   *
   * ```ts
   * const { data, error } = await supatype.functions.invoke('process-order', {
   *   body: { items: [...], address: {...} },
   * })
   * ```
   *
   * The current user's JWT is automatically included in the Authorization header.
   */
  async invoke<TResponse = unknown>(
    functionName: string,
    options?: FunctionInvokeOptions | undefined,
  ): Promise<{ data: TResponse | null; error: SupatypeError | null }> {
    const method = options?.method ?? "POST"
    const mergedHeaders: Record<string, string> = {
      ...this.headers,
      ...options?.headers,
    }

    const fetchOpts: RequestInit = {
      method,
      headers: mergedHeaders,
    }

    if (options?.body !== undefined && method !== "GET") {
      fetchOpts.body = JSON.stringify(options.body)
    }

    try {
      const res = await this.doFetch(
        `${this.baseUrl}/functions/v1/${functionName}`,
        fetchOpts,
      )

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>
        return {
          data: null,
          error: {
            message: typeof body["message"] === "string" ? body["message"] : `Function returned ${res.status}`,
            status: res.status,
            ...(typeof body["code"] === "string" ? { code: body["code"] } : {}),
          },
        }
      }

      const contentType = res.headers.get("content-type") ?? ""
      if (contentType.includes("application/json")) {
        const data = await res.json() as TResponse
        return { data, error: null }
      }

      // Return text for non-JSON responses
      const text = await res.text()
      return { data: text as unknown as TResponse, error: null }
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : "Network error" },
      }
    }
  }
}

export interface SupatypeClient<TDatabase extends AnyDatabase = AnyDatabase> {
  from<TTable extends keyof TDatabase["public"]["Tables"] & string>(
    table: TTable,
  ): TableClient<TDatabase["public"]["Tables"][TTable]>
  global<TRow extends Record<string, unknown> = Record<string, unknown>>(name: string): GlobalClient<TRow>
  auth: AuthClient
  storage: StorageClient
  realtime: RealtimeClient
  functions: FunctionsClient
  graphql(
    query: string,
    variables?: Record<string, unknown> | undefined,
  ): Promise<{ data: unknown; error: SupatypeError | null }>
  /**
   * Call a Postgres function via PostgREST's `/rpc/function_name` endpoint.
   *
   * ```ts
   * const { data, error } = await supatype.rpc('calculate_shipping', {
   *   weight: 2.5,
   *   country: 'GB',
   * })
   * ```
   *
   * When the database type includes `Functions`, parameters and return type
   * are fully typed.
   */
  rpc<TFn extends FunctionNames<TDatabase>>(
    fn: TFn,
    params?: FunctionArgs<TDatabase, TFn> | undefined,
    options?: { head?: boolean | undefined; count?: "exact" | "planned" | "estimated" | undefined } | undefined,
  ): Promise<RpcResult<FunctionReturns<TDatabase, TFn>>>
}

export function createClient<TDatabase extends AnyDatabase = AnyDatabase>(
  config: SupatypeClientConfig,
): SupatypeClient<TDatabase> {
  // Warn early if a direct Postgres URL is used in a serverless environment
  warnIfServerlessDirectConnection(config.url)

  const baseHeaders: Record<string, string> = {
    apikey: config.anonKey,
    "Content-Type": "application/json",
  }

  // Create a retry-aware fetch bound to client-level config
  const doFetch = createRetryFetch({
    retry: config.retry,
    timeout: config.timeout,
  })

  const auth = new AuthClient(`${config.url}/auth/v1`, baseHeaders)
  const storage = new StorageClient(`${config.url}/storage/v1`, baseHeaders)
  const realtime = new RealtimeClient(`${config.url}/realtime/v1`, baseHeaders)
  const functions = new FunctionsClient(config.url, baseHeaders, doFetch)

  const getAuthHeaders = (): Record<string, string> => {
    // The auth headers are merged dynamically so callers pick up fresh JWTs
    // after sign-in. Internal reference to auth._setSession isn't exposed;
    // instead we read currentSession via a closure.
    return baseHeaders
  }

  return {
    from<TTable extends keyof TDatabase["public"]["Tables"] & string>(
      table: TTable,
    ): TableClient<TDatabase["public"]["Tables"][TTable]> {
      type TDef = TDatabase["public"]["Tables"][TTable]
      return new TableClient<TDef>(config.url, table, getAuthHeaders())
    },

    global<TRow extends Record<string, unknown> = Record<string, unknown>>(name: string): GlobalClient<TRow> {
      const tableName = `_global_${name}`
      type TDef = { Row: TRow; Insert: TRow; Update: Partial<TRow> }
      return {
        async get(): Promise<{ data: TRow | null; error: SupatypeError | null }> {
          const tc = new TableClient<TDef>(config.url, tableName, getAuthHeaders())
          const result = await tc.select().limit(1).maybeSingle()
          return { data: result.data ?? null, error: result.error }
        },
        async update(data: Partial<TRow>): Promise<{ data: TRow | null; error: SupatypeError | null }> {
          const tc = new TableClient<TDef>(config.url, tableName, getAuthHeaders())
          const result = await tc.upsert(data as TRow)
          const row = Array.isArray(result.data) ? (result.data[0] as TRow | undefined) ?? null : null
          return { data: row, error: result.error }
        },
      }
    },

    auth,
    storage,
    realtime,
    functions,

    async graphql(
      query: string,
      variables?: Record<string, unknown> | undefined,
    ): Promise<{ data: unknown; error: SupatypeError | null }> {
      const body: Record<string, unknown> = { query }
      if (variables !== undefined) {
        body["variables"] = variables
      }
      let res: Response
      try {
        res = await doFetch(`${config.url}/graphql/v1`, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify(body),
        })
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : "Network error" } }
      }
      const json = await res.json() as Record<string, unknown>
      if (json["errors"] !== undefined) {
        const errors = json["errors"] as Array<{ message: string }>
        return { data: json["data"] ?? null, error: { message: (errors[0]?.message ?? "GraphQL error") } }
      }
      return { data: json["data"] ?? null, error: null }
    },

    async rpc<TFn extends FunctionNames<TDatabase>>(
      fn: TFn,
      params?: FunctionArgs<TDatabase, TFn> | undefined,
      options?: { head?: boolean | undefined; count?: "exact" | "planned" | "estimated" | undefined } | undefined,
    ): Promise<RpcResult<FunctionReturns<TDatabase, TFn>>> {
      const headers: Record<string, string> = { ...getAuthHeaders() }
      const method = options?.head === true ? "HEAD" : "POST"

      if (options?.count !== undefined) {
        headers["Prefer"] = `count=${options.count}`
      }

      let res: Response
      try {
        res = await doFetch(`${config.url}/rest/v1/rpc/${fn}`, {
          method,
          headers,
          ...(params !== undefined && method !== "HEAD" && { body: JSON.stringify(params) }),
        })
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : "Network error" } }
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>
        const pgError = PostgrestError.fromResponse(
          {
            message: typeof body["message"] === "string" ? body["message"] : undefined,
            code: typeof body["code"] === "string" ? body["code"] : undefined,
            details: typeof body["details"] === "string" ? body["details"] : undefined,
            hint: typeof body["hint"] === "string" ? body["hint"] : undefined,
          },
          res.status,
        )
        return {
          data: null,
          error: {
            message: pgError.message,
            status: pgError.statusCode,
            code: pgError.code,
          },
        }
      }

      if (method === "HEAD" || res.status === 204) {
        return { data: null, error: null }
      }

      const data = await res.json() as FunctionReturns<TDatabase, TFn>
      return { data, error: null }
    },
  }
}
