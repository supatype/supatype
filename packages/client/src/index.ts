import { AuthClient } from "./auth.js"
import { onIdentityChange } from "./identity.js"
import { PreviewCredential } from "./preview.js"
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
  RpcOptions,
  SelectQueryOptions,
} from "./types.js"
import { DRAFT_SCHEMA } from "./types.js"

export type {
  User,
  Session,
  AuthChangeEvent,
  AuthFlowType,
  SupatypeError,
  QueryResult,
  MaskedField,
  RpcResult,
  AnyDatabase,
  SupatypeClientConfig,
  FunctionDef,
  AuthStorage,
  RpcOptions,
  SelectQueryOptions,
  TableDef,
  TableInsert,
  SupatypeModels,
  SupatypeBuckets,
  SupatypeFunctions,
  AugmentedDatabase,
} from "./types.js"
export {
  generateCodeVerifier,
  createCodeChallengeS256,
  PKCE_METHOD_S256,
} from "./pkce.js"
export { DRAFT_SCHEMA } from "./types.js"

/**
 * A client whose database type the holder does not know.
 *
 * What every framework binding's context, provider or injection key is typed at. A context is one
 * value shared by many consumers, so it cannot be generic, and at the `AugmentedDatabase` default
 * it rejected `createClient<Database>(...)`, the client every real project builds. `AnyDatabase` is
 * the constraint every generated database satisfies, so the typed client goes in unchanged and each
 * binding's `useSupatype<TDatabase>()` narrows it on the way back out.
 *
 * Named here rather than spelled out in four packages so the decision has one home. It is also not
 * `any`: that widening is one TypeScript already allows, so `any` bought nothing and cost every
 * consumer its checking.
 */
export type AnyClient = SupatypeClient<AnyDatabase>
export type { QueryCacheOptions, CacheStatus } from "./query-cache.js"
export { AuthClient } from "./auth.js"
export { onIdentityChange, type IdentitySource } from "./identity.js"
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
export { PreviewLinkError } from "./preview.js"

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
  /**
   * The schema this table's reads come from, set by `draft()`.
   *
   * Mutable, and safe to be: `from()` builds a fresh client per call, so nothing is shared between
   * two queries. Reads only; a draft view is not writable and a write is an ordinary update that
   * records a new version.
   */
  private profile: string | undefined

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

  /**
   * Read the pending draft instead of what is published.
   *
   * ```typescript
   * const { data } = await supatype.from("posts").draft().select("id, title, body")
   * ```
   *
   * Selects the generated `draft` schema, whose views carry the same row type as the table, so the
   * only thing that changes is which schema answers. Available on models that declare `versions`;
   * anything else has no draft view and answers `PGRST106`.
   *
   * **Read-only, and permission is not the read rule.** A draft is visible to the record's creator
   * and to the project's elevated Studio roles, or to a caller holding a signed preview link. A
   * caller who may read published content is not thereby entitled to read what has not been
   * published. Write with the ordinary `update`, which records a new draft version; publish with
   * `supatype.publish`.
   */
  draft(): this {
    this.profile = DRAFT_SCHEMA
    return this
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
      // The profile joins the select options rather than riding a longer constructor: it is a
      // property of the request being described, like `count` and `head` beside it.
      { ...options, ...(this.profile !== undefined && { profile: this.profile }) },
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
   * Phase 10.6 F11: preferred over raw `client.realtime.channel(...)`.
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
    options?: RpcOptions | undefined,
  ): Promise<RpcResult<FunctionReturns<TDatabase, TFn>>>
}

export function createClient<TDatabase extends AnyDatabase = AugmentedDatabase>(
  config: SupatypeClientConfig,
): SupatypeClient<TDatabase> {
  // Warn early if a direct Postgres URL is used in a serverless environment
  warnIfServerlessDirectConnection(config.url)

  // A client with both is a route sending admin credentials down a path meant for strangers, which
  // is precisely what the preview link exists to remove. Thrown rather than warned: the two are
  // never both correct, and a warning in a server log is not read by whoever wrote the route.
  if (config.previewCode !== undefined && config.serviceRoleKey !== undefined) {
    throw new Error(
      "A Supatype client cannot carry both `previewCode` and `serviceRoleKey`. A preview link is " +
        "the bearer's whole credential and needs no admin key; sending one anyway would let " +
        "anybody who reached that route read everything.",
    )
  }

  // Built once and shared by every request this client makes, so a page rendering several queries
  // exchanges the code once rather than once per table.
  const previewCredential =
    config.previewCode === undefined || config.previewCode === ""
      ? null
      : new PreviewCredential(config.url, config.previewCode)

  const baseHeaders: Record<string, string> = {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    "Content-Type": "application/json",
    ...config.headers,
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
  const queryCache = config.queryCache ?? defaultQueryCache

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    // Studio and other admin tools pass serviceRoleKey, use it for table/RPC/GraphQL
    // so supatype_admin RLS policies and bypass rules apply (anon would fail).
    if (config.serviceRoleKey) {
      return {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...config.headers,
      }
    }
    // A preview link is the whole credential, and it comes before any session on purpose: whoever
    // opened the link may well be signed in as someone with no access to the draft, and quietly
    // using that identity would show them "not found".
    if (previewCredential !== null) {
      // Throws when the link will not resolve. The query layer turns that into an ordinary
      // `{ data: null, error }`, so a revoked link reads as a message rather than as a crash.
      return { ...baseHeaders, Authorization: `Bearer ${await previewCredential.token()}` }
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

  // Storage asks for headers per request, like every other client here.
  //
  // It used to be handed a plain object built above, before anybody had signed in, so every storage
  // request carried the anon key for the life of the page. An app's per-user storage policies saw
  // `anon` rather than the caller, and through Studio's proxy the request was refused outright,
  // because an anon key carries no `sub` and the proxy requires one.
  const storage = new StorageClient(`${config.url}/storage/v1`, getAuthHeaders)

  // The same provider the other sub-clients get, not `baseHeaders`.
  //
  // `baseHeaders` is built once and never mutated, so handing it over pinned every socket to the
  // anon key for the life of the page. Realtime enforces RLS, so on a table that is not
  // anon-readable the socket reported SUBSCRIBED and delivered nothing, which is exactly the
  // failure the storage note above describes.
  const realtime = new RealtimeClient(`${config.url}/realtime/v1`, getAuthHeaders)

  const onUnauthorized = config.serviceRoleKey
    ? undefined
    : (): Promise<void> => auth.ensureValidSession()

  const functions = new FunctionsClient(config.url, getAuthHeaders, doFetch, onUnauthorized)

  // Signing in has to reach an already-open socket.
  //
  // Every binding subscribes when its component mounts, which is before the user has signed in, so
  // the socket that matters is always one opened while signed out. Resolving the token per
  // connection is not enough on its own; something has to tell the connection it is now stale.
  //
  // `onIdentityChange`, not `onAuthStateChange`: a refreshed token is a different string for the
  // same person, and reconnecting on it would close and re-open the socket once an hour for the
  // life of the tab, losing every change committed in the gap. That is the silent miss this whole
  // change exists to remove, so it must not be reintroduced by the fix.
  //
  // The subscription is never torn down. The listener is held by `auth` and closes over `realtime`,
  // both owned by this client, so the cycle is collected whole when the client is dropped.
  onIdentityChange(auth, () => {
    void realtime.reauthenticate()
  })

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
      options?: RpcOptions | undefined,
    ): Promise<RpcResult<FunctionReturns<TDatabase, TFn>>> {
      const headers: Record<string, string> = { ...(await getAuthHeaders()) }
      const method = options?.head === true ? "HEAD" : "POST"

      if (options?.count !== undefined) {
        headers["Prefer"] = `count=${options.count}`
      }
      // PostgREST resolves `/rpc/<name>` against the default profile, so a function in any other
      // schema is unreachable without this. `Content-Profile` rather than `Accept-Profile`, because
      // an RPC call is a POST and PostgREST reads the write-side header for it.
      if (options?.schema !== undefined) {
        headers["Content-Profile"] = options.schema
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
