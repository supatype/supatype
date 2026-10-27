import { AuthClient } from "./auth.js"
import { onIdentityChange } from "./identity.js"
import { PreviewCredential } from "./preview.js"
import {
  QueryBuilder,
  MutationBuilder,
  fetchWithOptional401Retry,
  type DraftCreate,
  type HeadersProvider,
} from "./query.js"
import { registeredDraftModel } from "./draft-models-registry.js"
import { GENERATED_CLIENT_IMPORT } from "./generated-client.js"
import type { FetchOptions, RequestTransport } from "./fetch-with-retry.js"
import { defaultQueryCache, type QueryCache } from "./query-cache.js"
import { StorageClient } from "./storage.js"
import { RealtimeClient } from "./realtime.js"
import type { RealtimePayload } from "./realtime.js"
import { subscribeToTable, type TableSubscribeOptions, type TableSubscription } from "./table-subscription.js"
import { PostgrestError, transportFailure } from "./errors.js"
import { createRetryFetch } from "./retry.js"
import { isJsonObject, readJsonObject, refusalText } from "./json.js"
import { jwtRole } from "./jwt.js"
import { createGraphqlRunner } from "./graphql-transport.js"
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
  TableDef,
  UpdateOptions,
} from "./types.js"
import type { MutationOptions } from "./query.js"
import type { SelectRow } from "./select-types.js"
import { DRAFT_SCHEMA } from "./types.js"

export type {
  User,
  Session,
  AuthChangeEvent,
  AuthFlowType,
  SupatypeError,
  AuthRedirectError,
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
  TableRow,
  TableUpdate,
  SupatypeModels,
  SupatypeBuckets,
  SupatypeFunctions,
  AugmentedDatabase,
  DraftUpdateOptions,
  UpdateOptions,
} from "./types.js"
export {
  generateCodeVerifier,
  createCodeChallengeS256,
  PKCE_METHOD_S256,
} from "./pkce.js"
export { DRAFT_SCHEMA, PUBLISHING_SCHEMA } from "./types.js"
export type { SelectRow, SelectError, TableRelationship } from "./select-types.js"

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
export { QueryBuilder, MutationBuilder, type HeadersProvider, type RequestTransport } from "./query.js"
export { QueryCache, defaultQueryCache } from "./query-cache.js"
export { StorageClient, BucketClient } from "./storage.js"
export type { StorageObject, StorageFolder, StorageListEntry, ListOptions, RemovedObject, StorageReference, TransformOptions } from "./storage.js"
export { RealtimeClient } from "./realtime.js"
export type { RealtimeEvent, RealtimePayload, ChannelStatus, PresenceEntry } from "./realtime.js"
// The bindings' shared subscription helpers are on `@supatype/client/bindings`, not here.
export type { TableSubscribeOptions, TableSubscription } from "./table-subscription.js"
export * from "./errors.js"

// Called by the generated `supatype/generated/client.ts`, which is how a project tells the client which
// columns hold values a JSON parser would destroy. Exported because generated code imports it;
// applications do not call it.
export {
  registerFieldKinds,
  fieldKindsAreRegistered,
  forgetRegisteredFieldKinds,
  type FieldKindsDocument,
  type UnrecognisedFieldKindsDocument,
} from "./field-kinds-registry.js"
// Also called by the generated file: which tables keep drafts, so `insert` creates their records
// through `supatype.create_record`.
export {
  registerDraftModels,
  forgetRegisteredDraftModels,
  type DraftModel,
  type DraftModelsDocument,
  type UnrecognisedDraftModelsDocument,
} from "./draft-models-registry.js"
export { fetchWithRetry, detectServerlessEnvironment, warnIfServerlessDirectConnection } from "./fetch-with-retry.js"
export type { FetchOptions, ServerlessDetectionResult } from "./fetch-with-retry.js"
export { createRetryFetch } from "./retry.js"
export type { RetryConfig } from "./retry.js"
export { ERROR_CODES_DOCUMENTATION, getErrorDocumentation, getErrorCodesByCategory } from "./error-codes-doc.js"
export type { ErrorCodeEntry } from "./error-codes-doc.js"
export { CONNECTION_MODES, SERVERLESS_CONNECTION_WARNING, CONNECTION_FAQ } from "./serverless-docs.js"
export type { ConnectionModeDoc } from "./serverless-docs.js"
export { PreviewLinkError } from "./preview.js"
// pg_graphql sends its `JSON` scalar as a string and `graphql()` decodes it. These let another
// GraphQL client decode the same way with the schema it reads, and Studio's explorer run its
// send-as requests through the same runner.
export {
  GRAPHQL_SCHEMA_QUERY,
  GraphqlSchemaCache,
  decodeGraphqlJsonFields,
  readGraphqlSchema,
  type GraphqlJsonDecoding,
  type GraphqlSchema,
} from "./graphql-json.js"
export { createGraphqlRunner, type GraphqlTransport } from "./graphql-transport.js"

// ─── Table client ─────────────────────────────────────────────────────────────

/**
 * One table, typed by its definition and by every table beside it: an embedded select is resolved
 * against the other tables' rows and the relationships between them.
 */
class TableClient<
  TDef extends TableDef,
  TTables extends Record<string, TableDef> = Record<string, TableDef>,
  TName extends string = string,
> {
  private readonly baseUrl: string
  private readonly table: string
  private readonly path: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  /** The client's retry-aware fetch, so `timeout` and `retry` reach table requests too. */
  private readonly send: RequestTransport
  private readonly queryCache: QueryCache
  private readonly realtime: RealtimeClient
  /**
   * The schema this table's reads come from, set by `draft()`.
   *
   * Mutable, and safe to be: `from()` builds a fresh client per call, so nothing is shared between
   * two queries. Reads only: a draft view is not writable, and `update` on a model with drafts
   * saves a new version through the publishing functions instead.
   */
  private profile: string | undefined

  constructor(
    baseUrl: string,
    table: string,
    getHeaders: HeadersProvider,
    realtime: RealtimeClient,
    queryCache: QueryCache = defaultQueryCache,
    onUnauthorized: (() => Promise<void>) | undefined,
    send: RequestTransport,
  ) {
    this.baseUrl = baseUrl
    this.table = table
    this.path = `/rest/v1/${table}`
    this.getHeaders = getHeaders
    this.realtime = realtime
    this.onUnauthorized = onUnauthorized
    this.queryCache = queryCache
    this.send = send
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
   * published. Write with the ordinary `update`, which on a model with drafts saves a new draft of
   * each record it matches and leaves the live rows alone; pass `{ publish: true }` to publish in the
   * same call. A saved draft is published later by the generated `publish` database function in the
   * `supatype` schema:
   * `rpc("publish", { model_table: "posts", record_id: id }, { schema: "supatype" })`.
   */
  draft(): this {
    this.profile = DRAFT_SCHEMA
    return this
  }

  /**
   * Read rows, typed from the select string.
   *
   * `select("id, author:authors(name)")` resolves to `{ id: string; author: { name: string } | null }`
   * from the generated schema: columns, aliases and embedded relations are read from the string, so
   * the joined shape is not declared a second time by hand. See `select-types.ts` for the grammar.
   * A string only known at run time types as the whole row.
   */
  select<TColumns extends string = "*">(
    columns?: TColumns | undefined,
    options?: SelectQueryOptions | undefined,
  ): QueryBuilder<SelectRow<TTables, TName, TColumns>>
  /** Read rows typed as `TResult`, for a shape the select string cannot describe. */
  select<TResult>(
    columns?: string | undefined,
    options?: SelectQueryOptions | undefined,
  ): QueryBuilder<TResult>
  select<TResult>(
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
      this.send,
    )
  }

  /**
   * Insert one row or several.
   *
   * **On a model that keeps drafts**, one record is created through `supatype.create_record`, as
   * Studio creates it, and several through `supatype.create_records`, all or none in one call: each
   * record starts as its first draft, and the rows come back read from the draft view in the shape
   * and order a plain insert returns. A plain insert asking for the row back is refused there by a
   * read rule that hides unpublished records, because Postgres checks the returned row against it
   * before anything has made the new row visible to its author. The generated `supatype/generated/client.ts`
   * says which models keep drafts; a client without it inserts as before.
   */
  insert(
    data: TDef["Insert"] | TDef["Insert"][],
  ): MutationBuilder<TDef["Row"], TTables, TName> {
    return new MutationBuilder<TDef["Row"], TTables, TName>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "POST",
      data,
      { createThrough: this.draftCreate(data) },
      this.onUnauthorized,
      this.send,
    )
  }

  /** Where an insert of `data` is created through the publishing functions: any rows, on a drafts model. */
  private draftCreate(data: TDef["Insert"] | TDef["Insert"][]): DraftCreate | undefined {
    const model = registeredDraftModel(this.table)
    if (model === undefined) return undefined
    // Nothing to create: the plain insert answers an empty array with no rows, as it always has.
    if (Array.isArray(data) && data.length === 0) return undefined
    return { table: this.table, primaryKey: model.primaryKey }
  }

  /**
   * Insert, or update the row a key or unique column already names.
   *
   * Never sent through `create_record`, on a drafts model or not: it cannot say what happens on a
   * conflict, and an upsert that met an existing record would make a second one rather than update
   * it. On a drafts model whose read rule hides unpublished records, create through `insert`.
   */
  upsert(
    data: TDef["Insert"] | TDef["Insert"][],
  ): MutationBuilder<TDef["Row"], TTables, TName> {
    return new MutationBuilder<TDef["Row"], TTables, TName>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "POST",
      data,
      { upsert: true },
      this.onUnauthorized,
      this.send,
    )
  }

  /**
   * Change the rows the filters match.
   *
   * **On a model that keeps drafts** the live rows do not change: each matched record gets a new
   * draft through `supatype.save_drafts`, merged onto its newest version as Studio saves one, all or
   * none in one call, and the drafts come back read from the draft view. Pass `{ publish: true }` to
   * publish them in the same call, so the history records the version that went live. The generated
   * `supatype/generated/client.ts` says which models keep drafts; elsewhere this is a plain `PATCH`, and
   * `{ publish: true }` is refused, since there is nothing to publish.
   */
  update(
    data: TDef["Update"],
    options?: UpdateOptions<TDef>,
  ): MutationBuilder<TDef["Row"], TTables, TName> {
    return new MutationBuilder<TDef["Row"], TTables, TName>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "PATCH",
      data,
      this.draftEdit(options),
      this.onUnauthorized,
      this.send,
    )
  }

  /** How an update is made: as drafts on a drafts model, else a plain `PATCH`, or refused. */
  private draftEdit(options: unknown): MutationOptions | undefined {
    const publish = isJsonObject(options) && options["publish"] === true
    const model = registeredDraftModel(this.table)
    if (model !== undefined) return { editThrough: { table: this.table, primaryKey: model.primaryKey, publish } }
    if (!publish) return undefined
    const message = `{ publish: true } applies to a model that keeps drafts, and "${this.table}" is not one this client knows of. Import the client from the generated ${GENERATED_CLIENT_IMPORT}, which says which models keep drafts.`
    return { refusal: { message } }
  }

  delete(): MutationBuilder<TDef["Row"], TTables, TName> {
    return new MutationBuilder<TDef["Row"], TTables, TName>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      "DELETE",
      undefined,
      undefined,
      this.onUnauthorized,
      this.send,
    )
  }

  /**
   * Subscribe to postgres_changes for this table (typed to Row), and join.
   *
   * Phase 10.6 F11: preferred over raw `client.realtime.channel(...)`. The returned `channel` is
   * already subscribed; call `channel.subscribe(cb)` only to watch its status.
   *
   * Each call gets a channel of its own; `subscribeToTable` says why. The framework bindings join
   * through the same function, so a table subscribed either way behaves the same.
   */
  subscribe(
    callback: (payload: RealtimePayload<TDef["Row"]>) => void,
    opts?: TableSubscribeOptions | undefined,
  ): TableSubscription {
    return subscribeToTable(this.realtime, this.table, callback, opts)
  }
}

// ─── Main client ──────────────────────────────────────────────────────────────

export interface GlobalClient<TRow extends Record<string, unknown> = Record<string, unknown>> {
  get(): Promise<{ data: TRow | null; error: SupatypeError | null }>
  update(data: Partial<TRow>): Promise<{ data: TRow | null; error: SupatypeError | null }>
}

/**
 * The boundary between a function's answer and the return type the generated schema declares.
 *
 * A database or edge function may answer with any JSON value (an edge function with text, too), so
 * the only thing to check is that there is a value. That it has the declared type is the generated
 * schema's claim about the function, which nothing on the client can check.
 */
function isDeclaredReturn<T>(value: unknown): value is T {
  return value !== undefined
}

/**
 * The machine-readable code on an edge function's error body. A handler may send its own `code`;
 * the functions worker answers its own failures (`not_found`, `function_error`) under `error`.
 */
function functionErrorCode(body: Record<string, unknown>): string | undefined {
  const code = body["code"] ?? body["error"]
  return typeof code === "string" ? code : undefined
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
  /**
   * Retry this call on a transient failure although it is not a GET. Default: false.
   *
   * Only GET calls are retried otherwise: a POST that failed in flight may already have run the
   * function, and running it again could charge a card or send an email twice. Set this when a
   * second run is harmless.
   */
  idempotent?: boolean | undefined
}

class FunctionsClient {
  private readonly baseUrl: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly doFetch: RequestTransport

  constructor(
    baseUrl: string,
    getHeaders: HeadersProvider,
    doFetch: RequestTransport,
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

    const fetchOpts: RequestInit & FetchOptions = {
      method,
      ...(options?.idempotent === true && { idempotent: true }),
    }

    if (options?.body !== undefined && method !== "GET") {
      fetchOpts.body = JSON.stringify(options.body)
    }

    try {
      const res = await fetchWithOptional401Retry(
        this.doFetch,
        `${this.baseUrl}/functions/v1/${functionName}`,
        fetchOpts,
        resolveHeaders,
        this.onUnauthorized,
      )

      if (!res.ok) {
        const body = await readJsonObject(res)
        const code = functionErrorCode(body)
        return {
          data: null,
          error: {
            message: typeof body["message"] === "string" ? body["message"] : `Function returned ${res.status}`,
            status: res.status,
            ...(code !== undefined && { code }),
          },
        }
      }

      const contentType = res.headers.get("content-type") ?? ""
      // Text for a response that is not JSON.
      const data = contentType.includes("application/json") ? await res.json() : await res.text()
      return { data: isDeclaredReturn<EdgeFunctionReturns<TFn>>(data) ? data : null, error: null }
    } catch (e) {
      return { data: null, error: transportFailure(e) }
    }
  }
}

export interface SupatypeClient<TDatabase extends AnyDatabase = AugmentedDatabase> {
  url: string
  /** Service role key, if provided at construction time. Used by developer tools for admin API calls. */
  serviceRoleKey: string | undefined
  from<TTable extends keyof TDatabase["public"]["Tables"] & string>(
    table: TTable,
  ): TableClient<TDatabase["public"]["Tables"][TTable], TDatabase["public"]["Tables"], TTable>
  global<TRow extends Record<string, unknown> = Record<string, unknown>>(name: string): GlobalClient<TRow>
  auth: AuthClient
  storage: StorageClient
  realtime: RealtimeClient
  functions: FunctionsClient
  /**
   * Run a GraphQL query. `options.idempotent`: retry on a transient failure, for a query that is not
   * a mutation.
   *
   * Rich text, blocks and json fields come back as values, not as the JSON strings pg_graphql sends:
   * the client reads the schema once and decodes every field typed with its `JSON` scalar, through
   * aliases, fragments, relations and lists. `TData` names the answer's shape, typically from
   * `TableRow<"post">`; nothing checks it at runtime.
   */
  graphql<TData = unknown>(
    query: string,
    variables?: Record<string, unknown> | undefined,
    options?: { idempotent?: boolean | undefined } | undefined,
  ): Promise<{ data: TData | null; error: SupatypeError | null }>
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

  // `headers` may be a function, read on every request: Studio changes the acting mode it asks for
  // without rebuilding its client (and losing its session and sockets).
  const extraHeaders = (): Record<string, string> =>
    typeof config.headers === "function" ? config.headers() : (config.headers ?? {})

  const baseHeaders: Record<string, string> = {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    "Content-Type": "application/json",
    ...extraHeaders(),
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
    detectSessionInUrl: config.auth?.detectSessionInUrl,
    transport: doFetch,
  })
  const queryCache = config.queryCache ?? defaultQueryCache

  const credentialHeaders = async (): Promise<Record<string, string>> => {
    // Studio and other admin tools pass serviceRoleKey, use it for table/RPC/GraphQL
    // so supatype_admin RLS policies and bypass rules apply (anon would fail).
    if (config.serviceRoleKey) {
      return {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...extraHeaders(),
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

  // Every request's headers: its credential, then the caller's own extra headers as they are now.
  const getAuthHeaders = async (): Promise<Record<string, string>> => ({
    ...(await credentialHeaders()),
    ...extraHeaders(),
  })

  // Storage asks for headers per request, like every other client here.
  //
  // It used to be handed a plain object built above, before anybody had signed in, so every storage
  // request carried the anon key for the life of the page. An app's per-user storage policies saw
  // `anon` rather than the caller, and through Studio's proxy the request was refused outright,
  // because an anon key carries no `sub` and the proxy requires one.
  const storage = new StorageClient(`${config.url}/storage/v1`, getAuthHeaders, doFetch)

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
  const runGraphql = createGraphqlRunner({ endpoint: `${config.url}/graphql/v1`, send: doFetch, headers: getAuthHeaders, onUnauthorized })

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

  // One place that wires a table to this client's headers, cache, auth refresh and fetch.
  const tableClient = <
    TDef extends TableDef,
    TTables extends Record<string, TableDef> = Record<string, TableDef>,
    TName extends string = string,
  >(table: string): TableClient<TDef, TTables, TName> =>
    new TableClient<TDef, TTables, TName>(config.url, table, getAuthHeaders, realtime, queryCache, onUnauthorized, doFetch)

  return {
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,

    from<TTable extends keyof TDatabase["public"]["Tables"] & string>(
      table: TTable,
    ): TableClient<TDatabase["public"]["Tables"][TTable], TDatabase["public"]["Tables"], TTable> {
      type TDef = TDatabase["public"]["Tables"][TTable]
      return tableClient<TDef, TDatabase["public"]["Tables"], TTable>(table)
    },

    global<TRow extends Record<string, unknown> = Record<string, unknown>>(name: string): GlobalClient<TRow> {
      const tableName = `_global_${name}`
      // A global is one row that always exists, so a write to it names only the fields it changes.
      type TDef = { Row: TRow; Insert: Partial<TRow>; Update: Partial<TRow> }
      return {
        async get(): Promise<{ data: TRow | null; error: SupatypeError | null }> {
          const tc = tableClient<TDef, Record<string, TDef>>(tableName)
          const result = await tc.select().limit(1).maybeSingle()
          return { data: result.data ?? null, error: result.error }
        },
        async update(data: Partial<TRow>): Promise<{ data: TRow | null; error: SupatypeError | null }> {
          const tc = tableClient<TDef>(tableName)
          const result = await tc.upsert(data)
          const row = result.data?.[0] ?? null
          return { data: row, error: result.error }
        },
      }
    },

    auth,
    storage,
    realtime,
    functions,

    /**
     * Run a GraphQL query. Sent as a POST, so it is not retried unless `options.idempotent` says a
     * second copy is harmless, as it is for any query that is not a mutation.
     */
    async graphql<TData = unknown>(
      query: string,
      variables?: Record<string, unknown> | undefined,
      options?: { idempotent?: boolean | undefined } | undefined,
    ): Promise<{ data: TData | null; error: SupatypeError | null }> {
      const { data, error } = await runGraphql(query, variables, options)
      return { data: isDeclaredReturn<TData>(data) ? data : null, error }
    },

    async rpc<TFn extends FunctionNames<TDatabase>>(
      fn: TFn,
      params?: FunctionArgs<TDatabase, TFn> | undefined,
      options?: RpcOptions | undefined,
    ): Promise<RpcResult<FunctionReturns<TDatabase, TFn>>> {
      const method = options?.head === true ? "HEAD" : "POST"
      // Resolved per attempt, so the resend after a 401 carries the same `Prefer` and profile as
      // the first send. It used to rebuild only `Prefer` and drop the schema.
      const rpcHeaders = async (): Promise<Record<string, string>> => ({
        ...(await getAuthHeaders()),
        ...(options?.count !== undefined && { Prefer: `count=${options.count}` }),
        // PostgREST resolves `/rpc/<name>` against the default profile, so a function in any other
        // schema is unreachable without this. `Content-Profile` rather than `Accept-Profile`,
        // because an RPC call is a POST and PostgREST reads the write-side header for it.
        ...(options?.schema !== undefined && { "Content-Profile": options.schema }),
      })

      let res: Response
      try {
        res = await fetchWithOptional401Retry(
          doFetch,
          `${config.url}/rest/v1/rpc/${fn}`,
          {
            method,
            ...(params !== undefined && method !== "HEAD" && { body: JSON.stringify(params) }),
            ...(options?.idempotent === true && { idempotent: true }),
          },
          rpcHeaders,
          onUnauthorized,
        )
      } catch (e) {
        return { data: null, error: transportFailure(e) }
      }

      if (!res.ok) {
        const body = await readJsonObject(res)
        const pgError = PostgrestError.fromResponse(
          {
            message: refusalText(body),
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
            ...(pgError.hint !== null && pgError.hint !== "" && { hint: pgError.hint }),
            ...(pgError.details !== null && pgError.details !== "" && { details: pgError.details }),
          },
        }
      }

      if (method === "HEAD" || res.status === 204) {
        return { data: null, error: null }
      }

      const data = await res.json()
      return { data: isDeclaredReturn<FunctionReturns<TDatabase, TFn>>(data) ? data : null, error: null }
    },
  }
}
