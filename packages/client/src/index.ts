import { AuthClient } from "./auth.js"
import { QueryBuilder, MutationBuilder, type HeadersProvider } from "./query.js"
import { defaultQueryCache, type QueryCache } from "./query-cache.js"
import { StorageClient } from "./storage.js"
import { RealtimeClient } from "./realtime.js"
import type { RealtimeEvent, RealtimePayload } from "./realtime.js"
import { PostgrestError } from "./errors.js"
import { createRetryFetch } from "./retry.js"
import { warnIfServerlessDirectConnection } from "./fetch-with-retry.js"
import type {
  AnyDatabase,
  AugmentedDatabase,
  FunctionDef,
  RpcResult,
  SupatypeFunctions,
  SupatypeClientConfig,
  SupatypeError,
  SelectQueryOptions,
} from "./types.js"

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
  AuthStorage,
  SelectQueryOptions,
  TableDef,
  TableInsert,
  SupatypeModels,
  SupatypeBuckets,
  SupatypeFunctions,
  AugmentedDatabase,
} from "./types.js"
export type { QueryCacheOptions, CacheStatus } from "./query-cache.js"
export { AuthClient } from "./auth.js"
export { QueryBuilder, MutationBuilder, type HeadersProvider } from "./query.js"
export { QueryCache, defaultQueryCache } from "./query-cache.js"
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
  private readonly table: string
  private readonly path: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly queryCache: QueryCache
  private readonly realtime: RealtimeClient

  constructor(
    baseUrl: string,
    table: string,
    getHeaders: HeadersProvider,
    realtime: RealtimeClient,
    queryCache: QueryCache = defaultQueryCache,
    onUnauthorized?: (() => Promise<void>) | undefined,
  ) {
    this.baseUrl = baseUrl
    this.table = table
    this.path = `/rest/v1/${table}`
    this.getHeaders = getHeaders
    this.realtime = realtime
    this.onUnauthorized = onUnauthorized
    this.queryCache = queryCache
  }

  select<TResult = TDef["Row"]>(
    columns?: string | undefined,
    options?: SelectQueryOptions | undefined,
  ): QueryBuilder<TResult> {
    return new QueryBuilder<TResult>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      columns,
      this.queryCache,
      this.onUnauthorized,
      options,
    )
  }

  insert(
    data: TDef["Insert"] | TDef["Insert"][],
  ): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "POST",
      data,
      undefined,
      this.onUnauthorized,
    )
  }

  upsert(
    data: TDef["Insert"] | TDef["Insert"][],
  ): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "POST",
      data,
      { upsert: true },
      this.onUnauthorized,
    )
  }

  update(data: TDef["Update"]): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "PATCH",
      data,
      undefined,
      this.onUnauthorized,
    )
  }

  delete(): MutationBuilder<TDef["Row"]> {
    return new MutationBuilder<TDef["Row"]>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "DELETE",
      undefined,
      undefined,
      this.onUnauthorized,
    )
  }

  /**
   * Subscribe to postgres_changes for this table (typed to Row).
   * Phase 10.6 F11 — preferred over raw `client.realtime.channel(...)`.
   */
  subscribe(
    callback: (payload: RealtimePayload<TDef["Row"]>) => void,
    opts?: {
      event?: RealtimeEvent | undefined
      filter?: string | undefined
      schema?: string | undefined
    } | undefined,
  ): {
    unsubscribe: () => void
    channel: ReturnType<RealtimeClient["channel"]>
  } {
    const event = opts?.event ?? "*"
    const schema = opts?.schema ?? "public"
    const channel = this.realtime
      .channel(`${schema}:${this.table}`)
      .on(
        "postgres_changes",
        {
          event,
          schema,
          table: this.table,
          ...(opts?.filter !== undefined && { filter: opts.filter }),
        },
        callback,
      )
    return {
      channel,
      unsubscribe: () => {
        channel.unsubscribe()
      },
    }
  }
}

// ─── Main client ──────────────────────────────────────────────────────────────

export interface GlobalClient<TRow extends Record<string, unknown> = Record<string, unknown>> {
  get(): Promise<{ data: TRow | null; error: SupatypeError | null }>
  update(data: Partial<TRow>): Promise<{ data: TRow | null; error: SupatypeError | null }>
}

function jwtRole(token: string): string | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payloadJson =
      typeof atob === "function"
        ? atob(parts[1] ?? "")
        : Buffer.from(parts[1] ?? "", "base64").toString("utf-8")
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    return typeof payload["role"] === "string" ? payload["role"] : null
  } catch {
    return null
  }
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

type EdgeFunctionNames =
  [keyof SupatypeFunctions] extends [never]
    ? string
    : keyof SupatypeFunctions & string

type EdgeFunctionArgs<TFn extends string> =
  [keyof SupatypeFunctions] extends [never]
    ? unknown
    : TFn extends keyof SupatypeFunctions
      ? SupatypeFunctions[TFn] extends FunctionDef
        ? SupatypeFunctions[TFn]["Args"]
        : unknown
      : unknown

type EdgeFunctionReturns<TFn extends string> =
  [keyof SupatypeFunctions] extends [never]
    ? unknown
    : TFn extends keyof SupatypeFunctions
      ? SupatypeFunctions[TFn] extends FunctionDef
        ? SupatypeFunctions[TFn]["Returns"]
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
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly doFetch: (url: string, init?: RequestInit) => Promise<Response>

  constructor(
    baseUrl: string,
    getHeaders: HeadersProvider,
    doFetch: (url: string, init?: RequestInit) => Promise<Response>,
    onUnauthorized?: (() => Promise<void>) | undefined,
  ) {
    this.baseUrl = baseUrl
    this.getHeaders = getHeaders
    this.doFetch = doFetch
    this.onUnauthorized = onUnauthorized
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
  async invoke<TFn extends EdgeFunctionNames>(
    functionName: TFn,
    options?: (Omit<FunctionInvokeOptions, "body"> & { body?: EdgeFunctionArgs<TFn> | undefined }) | undefined,
  ): Promise<{ data: EdgeFunctionReturns<TFn> | null; error: SupatypeError | null }> {
    const method = options?.method ?? "POST"
    const resolveHeaders = async (): Promise<Record<string, string>> => ({
      ...(await this.getHeaders()),
      ...options?.headers,
    })

    const fetchOpts: RequestInit = {
      method,
    }

    if (options?.body !== undefined && method !== "GET") {
      fetchOpts.body = JSON.stringify(options.body)
    }

    try {
      let headers = await resolveHeaders()
      let res = await this.doFetch(
        `${this.baseUrl}/functions/v1/${functionName}`,
        { ...fetchOpts, headers },
      )
      if (res.status === 401 && this.onUnauthorized !== undefined) {
        await this.onUnauthorized()
        headers = await resolveHeaders()
        res = await this.doFetch(
          `${this.baseUrl}/functions/v1/${functionName}`,
          { ...fetchOpts, headers },
        )
      }

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
        const data = await res.json() as EdgeFunctionReturns<TFn>
        return { data, error: null }
      }

      // Return text for non-JSON responses
      const text = await res.text()
      return { data: text as unknown as EdgeFunctionReturns<TFn>, error: null }
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : "Network error" },
      }
    }
  }
}

export interface SupatypeClient<TDatabase extends AnyDatabase = AugmentedDatabase> {
  url: string
  /** Service role key, if provided at construction time. Used by developer tools for admin API calls. */
  serviceRoleKey: string | undefined
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

export function createClient<TDatabase extends AnyDatabase = AugmentedDatabase>(
  config: SupatypeClientConfig,
): SupatypeClient<TDatabase> {
  // Warn early if a direct Postgres URL is used in a serverless environment
  warnIfServerlessDirectConnection(config.url)

  const baseHeaders: Record<string, string> = {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    "Content-Type": "application/json",
  }

  // Create a retry-aware fetch bound to client-level config
  const doFetch = createRetryFetch({
    retry: config.retry,
    timeout: config.timeout,
  })

  const auth = new AuthClient(`${config.url}/auth/v1`, baseHeaders, {
    initialSession: config.initialSession,
    persistSession: config.auth?.persistSession,
    storageKey: config.auth?.storageKey,
    cookiePrefix: config.auth?.cookiePrefix,
    storage: config.auth?.storage,
  })
  // Storage admin operations (listBuckets, createBucket, etc.) require service_role.
  // When a service role key is provided (developer tools like Studio), use it for
  // storage so admin calls are authorised; otherwise fall back to the anon headers.
  const storageHeaders: Record<string, string> = config.serviceRoleKey
    ? {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      }
    : baseHeaders
  const storage = new StorageClient(`${config.url}/storage/v1`, storageHeaders)
  const realtime = new RealtimeClient(`${config.url}/realtime/v1`, baseHeaders)
  const queryCache = config.queryCache ?? defaultQueryCache

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    // Studio and other admin tools pass serviceRoleKey — use it for table/RPC/GraphQL
    // so supatype_admin RLS policies and bypass rules apply (anon would fail).
    if (config.serviceRoleKey) {
      return {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      }
    }
    await auth.ensureValidSession()
    const token = auth.currentAccessToken
    if (token !== null) {
      const role = jwtRole(token)
      // Guardrail: malformed sessions can carry a JWT with empty role, which
      // PostgREST rejects ("role \"\" does not exist"). Fall back to anon.
      if (role !== null && role.trim().length > 0) {
        return { ...baseHeaders, Authorization: `Bearer ${token}` }
      }
    }
    return baseHeaders
  }

  const onUnauthorized = config.serviceRoleKey
    ? undefined
    : (): Promise<void> => auth.ensureValidSession()

  const functions = new FunctionsClient(config.url, getAuthHeaders, doFetch, onUnauthorized)

  return {
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,

    from<TTable extends keyof TDatabase["public"]["Tables"] & string>(
      table: TTable,
    ): TableClient<TDatabase["public"]["Tables"][TTable]> {
      type TDef = TDatabase["public"]["Tables"][TTable]
      return new TableClient<TDef>(config.url, table, getAuthHeaders, realtime, queryCache, onUnauthorized)
    },

    global<TRow extends Record<string, unknown> = Record<string, unknown>>(name: string): GlobalClient<TRow> {
      const tableName = `_global_${name}`
      type TDef = { Row: TRow; Insert: TRow; Update: Partial<TRow> }
      return {
        async get(): Promise<{ data: TRow | null; error: SupatypeError | null }> {
          const tc = new TableClient<TDef>(config.url, tableName, getAuthHeaders, realtime, queryCache, onUnauthorized)
          const result = await tc.select().limit(1).maybeSingle()
          return { data: result.data ?? null, error: result.error }
        },
        async update(data: Partial<TRow>): Promise<{ data: TRow | null; error: SupatypeError | null }> {
          const tc = new TableClient<TDef>(config.url, tableName, getAuthHeaders, realtime, queryCache, onUnauthorized)
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
          headers: await getAuthHeaders(),
          body: JSON.stringify(body),
        })
        if (res.status === 401 && onUnauthorized !== undefined) {
          await onUnauthorized()
          res = await doFetch(`${config.url}/graphql/v1`, {
            method: "POST",
            headers: await getAuthHeaders(),
            body: JSON.stringify(body),
          })
        }
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : "Network error" } }
      }
      let json: Record<string, unknown>
      try {
        json = await res.json() as Record<string, unknown>
      } catch {
        return { data: null, error: { message: `GraphQL endpoint returned a non-JSON response (HTTP ${res.status} ${res.statusText})` } }
      }
      if (!res.ok) {
        const message =
          typeof json["message"] === "string" ? json["message"]
          : typeof json["error"] === "string" ? json["error"]
          : `GraphQL request failed (HTTP ${res.status})`
        return { data: json["data"] ?? null, error: { message, status: res.status } }
      }
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
      const headers: Record<string, string> = { ...(await getAuthHeaders()) }
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
        if (res.status === 401 && onUnauthorized !== undefined) {
          await onUnauthorized()
          const retryHeaders: Record<string, string> = { ...(await getAuthHeaders()) }
          if (options?.count !== undefined) {
            retryHeaders["Prefer"] = `count=${options.count}`
          }
          res = await doFetch(`${config.url}/rest/v1/rpc/${fn}`, {
            method,
            headers: retryHeaders,
            ...(params !== undefined && method !== "HEAD" && { body: JSON.stringify(params) }),
          })
        }
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
