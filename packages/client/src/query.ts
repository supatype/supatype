import type { QueryCache, QueryCacheOptions, CacheStatus } from "./query-cache.js"
import { buildCacheKey, defaultQueryCache } from "./query-cache.js"
import type { MaskedField, QueryResult, SelectQueryOptions, SupatypeError, TableDef } from "./types.js"
import { DRAFT_SCHEMA, PUBLISHING_SCHEMA } from "./types.js"
import { createCall, createdKeys, inCreatedOrder, readBackColumns } from "./draft-create.js"
import type { SelectRow } from "./select-types.js"
import { parseRowsExactly, tableFromPath } from "./exact-response.js"
import { stringifyWithBigInts } from "./exact-values.js"
import { FilterBuilder } from "./filters.js"
import { PostgrestErrorCodes, transportFailure } from "./errors.js"
import { plainFetch, type FetchOptions, type RequestTransport } from "./fetch-with-retry.js"
import { isJsonObject, isOneOf, readJsonObject } from "./json.js"
import { decodeJwtPayload } from "./jwt.js"

const DEBUG_AUTH =
  (typeof process !== "undefined" && process.env["NEXT_PUBLIC_SUPATYPE_DEBUG_AUTH"] === "1") ||
  (typeof process !== "undefined" && process.env["SUPATYPE_DEBUG_AUTH"] === "1")

function decodeJwtRoleFromAuthHeader(headers: Record<string, string>): string | null {
  const auth = headers["Authorization"] ?? headers["authorization"]
  if (auth === undefined || !auth.startsWith("Bearer ")) return null
  const token = auth.slice("Bearer ".length)
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const role = decodeJwtPayload(parts[1] ?? "")?.["role"]
  return typeof role === "string" ? role : null
}

/**
 * The boundary between a parsed body and the row type the caller declared for the table.
 *
 * PostgREST answers a table read or write with JSON objects, which is what is checked. That each
 * object holds `TRow`'s columns is the generated schema's claim about the database, or the
 * caller's own for `select<TResult>()`, which nothing on the client can check.
 */
function isCallerRow<TRow>(value: unknown): value is TRow {
  return isJsonObject(value)
}

/** The rows a body holds: an array of objects, or one object (the single-object Accept). */
function callerRows<TRow>(value: unknown): TRow[] | null {
  if (Array.isArray(value)) return value.every(isCallerRow<TRow>) ? value : null
  return isCallerRow<TRow>(value) ? [value] : null
}

/** The body was JSON but not rows: PostgREST does not answer a table request that way. */
function notRows(status: number): SupatypeError {
  return { message: `Unexpected response body: expected rows (HTTP ${status})`, status }
}

/**
 * Parse `X-Supatype-Masked-Fields: salary=row, ssn=identity`.
 *
 * Unrecognised entries are dropped rather than guessed at: this is advisory decoration, so
 * a header from a newer server saying something this client does not understand should
 * degrade to silence, never to a wrong claim about which columns are masked.
 */
export function parseMaskedFields(header: string | null): MaskedField[] | undefined {
  if (header === null || header.trim() === "") return undefined

  const fields: MaskedField[] = []
  for (const entry of header.split(",")) {
    const [column, scope] = entry.split("=", 2).map((part) => part.trim())
    if (column === undefined || column === "") continue
    if (scope !== "identity" && scope !== "row") continue
    fields.push({ column, scope })
  }

  return fields.length > 0 ? fields : undefined
}

/**
 * `.single()` answered without exactly one row, worded as PostgREST 14 words it, so a caller sees
 * the same error whether PostgREST refused the request or the client found the rows wrong.
 */
function notOneRow(): SupatypeError {
  return { message: "Cannot coerce the result to a single JSON object", code: PostgrestErrorCodes.NOT_FOUND }
}

/**
 * The error a refused request answered with, for a read and a write alike.
 *
 * One function for both because they drifted: the write path dropped `field`, and a field
 * validator only ever runs on a write, so the column it named never reached the caller.
 */
function refusal(err: Record<string, unknown>, status: number): SupatypeError {
  return {
    message: String(err["message"] ?? err["hint"] ?? "Request failed"),
    status,
    ...(err["code"] !== undefined && { code: String(err["code"]) }),
    // A field validator's refusal names the column it refused. Kept whole rather than folded into
    // the message, so a form can mark the input.
    ...(typeof err["field"] === "string" && { field: err["field"] }),
    ...(typeof err["hint"] === "string" && err["hint"] !== "" && { hint: err["hint"] }),
    ...(typeof err["details"] === "string" && err["details"] !== "" && { details: err["details"] }),
  }
}

/** The refusal a failed request answered with, logged with `context` when auth debugging is on. */
async function readRefusal(
  res: Response,
  label: string,
  context: () => Promise<Record<string, unknown>>,
): Promise<SupatypeError> {
  const err = await readJsonObject(res, { message: "Error" })
  if (DEBUG_AUTH) {
    console.log(label, {
      ...(await context()),
      status: res.status,
      message: String(err["message"] ?? err["hint"] ?? "Request failed"),
      code: typeof err["code"] === "string" ? err["code"] : null,
    })
  }
  return refusal(err, res.status)
}

/**
 * The rows a successful body holds.
 *
 * Read from the text rather than `res.json()`: a bigInt, decimal or money column is already ruined
 * by the time `JSON.parse` returns, and the digits are only recoverable from the body.
 */
function readRows<TRow>(body: string, path: string, status: number, count: number | null): QueryResult<TRow[]> {
  const parsed = parseRowsExactly(body, tableFromPath(path))
  if (!parsed.ok) return { data: null, error: { message: parsed.message, status }, count: null }
  const rows = callerRows<TRow>(parsed.value)
  if (rows === null) return { data: null, error: notRows(status), count: null }
  return { data: rows, error: null, count }
}

const isServerCacheStatus = isOneOf(["HIT", "MISS", "BYPASS"])

/** What the server said of its cache, else MISS for a cached read, else nothing. */
function cacheStatusOf(header: string | null, cached: boolean): CacheStatus {
  if (isServerCacheStatus(header)) return header
  return cached ? "MISS" : undefined
}

function withMeta<T>(
  result: QueryResult<T>,
  meta: { cacheStatus?: CacheStatus; maskedFields?: MaskedField[] | undefined },
): QueryResult<T> {
  const { cacheStatus, maskedFields } = meta
  if (cacheStatus === undefined && maskedFields === undefined) return result
  return {
    ...result,
    meta: {
      ...(result.meta ?? {}),
      ...(cacheStatus !== undefined && { cacheStatus }),
      ...(maskedFields !== undefined && { maskedFields }),
    },
  }
}

/** Resolves auth (and other) headers at request time so token refresh can run first. */
export type HeadersProvider = () => Promise<Record<string, string>>

export function asHeadersProvider(
  headers: Record<string, string> | HeadersProvider,
): HeadersProvider {
  if (typeof headers === "function") return headers
  return () => Promise.resolve(headers)
}

/**
 * The caller's own token out of a header set: the session's bearer, else the apikey.
 *
 * One home for a rule three places had implemented separately. The realtime socket had the
 * precedence the other way round, which is how it came to authenticate as anon on every
 * connection: `apikey` is always set, so it never reached the Authorization header.
 *
 * Header names are matched in both casings because `config.headers` is caller-supplied and
 * lowercase is just as valid over the wire.
 */
export function bearerToken(headers: Record<string, string>): string {
  const authorization = headers["Authorization"] ?? headers["authorization"] ?? ""
  if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length)
  return headers["apikey"] ?? headers["Apikey"] ?? ""
}

// `createClient` passes its retrying fetch, so `config.timeout` and `config.retry` reach table reads
// and writes as they reach every other request. A builder constructed directly, without one, sends
// with plain `fetch` as it always has.
export type { RequestTransport }

/** Send once; on a 401, let the session refresh and send again with freshly resolved headers. */
export async function fetchWithOptional401Retry(
  send: RequestTransport,
  url: string,
  init: RequestInit & FetchOptions,
  resolveHeaders: () => Promise<Record<string, string>>,
  onUnauthorized?: (() => Promise<void>) | undefined,
): Promise<Response> {
  let headers = await resolveHeaders()
  let res = await send(url, { ...init, headers })
  if (res.status === 401 && onUnauthorized !== undefined) {
    await onUnauthorized()
    headers = await resolveHeaders()
    res = await send(url, { ...init, headers })
  }
  return res
}

/**
 * The total from PostgREST's `Content-Range: <range>/<total>`, or null when there is none.
 *
 * PostgREST sends the header on every read, and the total is `*` unless the request asked for a
 * count with `Prefer: count=...`. Reading `*` as a number gave `NaN` on every ordinary query.
 */
export function parseContentRangeTotal(header: string | null): number | null {
  const total = header?.split("/")[1]
  return total !== undefined && /^\d+$/.test(total) ? Number(total) : null
}

// ─── QueryBuilder ─────────────────────────────────────────────────────────────

export class QueryBuilder<TRow> extends FilterBuilder implements PromiseLike<QueryResult<TRow[]>> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly send: RequestTransport
  private readonly extraHeaders: Record<string, string>
  private readonly queryCache: QueryCache
  private cacheOptions: QueryCacheOptions | undefined
  private readonly countMode: SelectQueryOptions["count"]
  private readonly head: boolean

  constructor(
    baseUrl: string,
    path: string,
    headers: Record<string, string> | HeadersProvider,
    columns?: string | undefined,
    queryCache: QueryCache = defaultQueryCache,
    onUnauthorized?: (() => Promise<void>) | undefined,
    selectOptions?: SelectQueryOptions | undefined,
    transport: RequestTransport = plainFetch,
  ) {
    super()
    this.baseUrl = baseUrl
    this.path = path
    this.getHeaders = asHeadersProvider(headers)
    this.onUnauthorized = onUnauthorized
    this.send = transport
    this.extraHeaders = {}
    this.queryCache = queryCache
    this.countMode = selectOptions?.count
    this.head = selectOptions?.head === true
    if (columns !== undefined) {
      this.params.set("select", columns)
    }
    if (this.countMode !== undefined) {
      this.extraHeaders["Prefer"] = `count=${this.countMode}`
    }
    // A profile picks the schema that answers, which is how a draft is read: same table name, same
    // row type, one header. Set at construction rather than as a chainable step, so it cannot be
    // added to a request that has already been described.
    if (selectOptions?.profile !== undefined) {
      this.extraHeaders["Accept-Profile"] = selectOptions.profile
    }
  }

  /** Enable GET caching. Use `{ server: true }` for Valkey-backed server cache. */
  cache(options: QueryCacheOptions): this {
    this.cacheOptions = options
    return this
  }

  select(columns: string): this {
    this.params.set("select", columns)
    return this
  }

  order(
    column: string,
    opts?: { ascending?: boolean | undefined; nullsFirst?: boolean | undefined } | undefined,
  ): this {
    const dir = opts?.ascending === false ? "desc" : "asc"
    const nulls = opts?.nullsFirst === true ? "nullsfirst" : "nullslast"
    // One parameter, comma-separated: PostgREST reads only the first `order`, so appending a second
    // dropped every column after the first without an error.
    const term = `${column}.${dir}.${nulls}`
    const prior = this.params.get("order")
    this.params.set("order", prior === null ? term : `${prior},${term}`)
    return this
  }

  limit(count: number): this {
    this.params.set("limit", String(count))
    return this
  }

  /** Set the locale for resolving localized fields. */
  locale(code: string): this {
    this.extraHeaders["Accept-Language"] = code
    return this
  }

  range(from: number, to: number): this {
    this.extraHeaders["Range"] = `${from}-${to}`
    this.extraHeaders["Range-Unit"] = "items"
    return this
  }

  /** Return a single row (errors if none or many found). */
  async single(): Promise<QueryResult<TRow>> {
    const { data, error, meta } = await this._fetch({
      Accept: "application/vnd.pgrst.object+json",
    })
    if (error !== null) return { data: null, error, count: null, ...(meta && { meta }) }
    // The single-object body and a one-element array (from a proxy that dropped Accept) both
    // arrive here as rows: `callerRows` reads either.
    const row = data === null ? null : data[0]
    if (row === undefined) {
      return {
        data: null,
        error: notOneRow(),
        count: null,
        ...(meta && { meta }),
      }
    }
    return { data: row, error: null, count: 1, ...(meta && { meta }) }
  }

  /** Return a single row or null (errors if many found). */
  async maybeSingle(): Promise<QueryResult<TRow | null>> {
    const { data, error, count, meta } = await this._fetch({})
    if (error !== null) return { data: null, error, count: null, ...(meta && { meta }) }
    const row = data?.[0] ?? null
    return { data: row, error: null, count, ...(meta && { meta }) }
  }

  then<R1 = QueryResult<TRow[]>, R2 = never>(
    onfulfilled?: ((value: QueryResult<TRow[]>) => R1 | PromiseLike<R1>) | null | undefined,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null | undefined,
  ): PromiseLike<R1 | R2> {
    return this._fetch({}).then(onfulfilled, onrejected)
  }

  private buildRequestUrl(): string {
    const qs = this.params.toString()
    return `${this.baseUrl}${this.path}${qs ? `?${qs}` : ""}`
  }

  private applyServerCacheHeader(headers: Record<string, string>): Record<string, string> {
    if (!this.cacheOptions?.server) return headers
    const seconds = Math.max(1, Math.floor(this.cacheOptions.ttl / 1000))
    const cacheDirective =
      this.cacheOptions.public === true
        ? `max-age=${seconds}, public`
        : `max-age=${seconds}`
    return {
      ...headers,
      "X-Supatype-Cache": cacheDirective,
    }
  }

  private mergePreferHeader(
    headers: Record<string, string>,
    extra: Record<string, string>,
  ): Record<string, string> {
    const merged = { ...headers, ...extra }
    const preferParts = [headers["Prefer"], extra["Prefer"]].filter(Boolean)
    if (preferParts.length > 0) {
      merged["Prefer"] = preferParts.join(",")
    }
    return merged
  }

  private async _fetch(fetchHeaders: Record<string, string>): Promise<QueryResult<TRow[]>> {
    const mergedExtra = this.mergePreferHeader(this.extraHeaders, fetchHeaders)
    const url = this.buildRequestUrl()
    const method = this.head ? "HEAD" : "GET"
    const resolveRequestHeaders = async (): Promise<Record<string, string>> =>
      this.applyServerCacheHeader({ ...(await this.getHeaders()), ...mergedExtra })

    const cached = await this.cachedResult(url, resolveRequestHeaders)
    if (cached) return withMeta(cached, { cacheStatus: "HIT" })

    let res: Response
    try {
      res = await fetchWithOptional401Retry(this.send, url, { method }, resolveRequestHeaders, this.onUnauthorized)
    } catch (e) {
      return { data: null, error: transportFailure(e), count: null }
    }

    const result = await this.readResult(res, method, url, resolveRequestHeaders)
    await this.remember(url, resolveRequestHeaders, result)
    return withMeta(result, {
      cacheStatus: cacheStatusOf(res.headers.get("X-Supatype-Cache-Status"), this.cacheOptions !== undefined),
      maskedFields: parseMaskedFields(res.headers.get("X-Supatype-Masked-Fields")),
    })
  }

  /** The cached result for this read, when it is cached and the cache holds one. */
  private async cachedResult(
    url: string,
    resolveRequestHeaders: () => Promise<Record<string, string>>,
  ): Promise<QueryResult<TRow[]> | null> {
    if (!this.cacheOptions || this.head) return null
    return this.queryCache.get<TRow[]>(await this.cacheKey(url, this.cacheOptions, resolveRequestHeaders))
  }

  /** Cache a read's rows, when this read is cached and it returned rows. */
  private async remember(
    url: string,
    resolveRequestHeaders: () => Promise<Record<string, string>>,
    result: QueryResult<TRow[]>,
  ): Promise<void> {
    if (!this.cacheOptions || result.error !== null || result.data === null) return
    const key = await this.cacheKey(url, this.cacheOptions, resolveRequestHeaders)
    this.queryCache.set(key, result, this.cacheOptions.ttl)
  }

  /** What the response says: a refusal, no body (HEAD or 204), or the rows. */
  private async readResult(
    res: Response,
    method: "GET" | "HEAD",
    url: string,
    resolveRequestHeaders: () => Promise<Record<string, string>>,
  ): Promise<QueryResult<TRow[]>> {
    if (!res.ok) {
      const error = await readRefusal(res, "[supatype:query] request failed", async () => ({
        url,
        role: decodeJwtRoleFromAuthHeader(await resolveRequestHeaders()),
      }))
      return { data: null, error, count: null }
    }
    const count = parseContentRangeTotal(res.headers.get("content-range"))
    if (method === "HEAD" || res.status === 204) return { data: null, error: null, count }
    return readRows<TRow>(await res.text(), this.path, res.status, count)
  }

  private async cacheKey(
    url: string,
    options: QueryCacheOptions,
    resolveRequestHeaders: () => Promise<Record<string, string>>,
  ): Promise<string> {
    return buildCacheKey("GET", url, await resolveRequestHeaders(), {
      partition: options.key,
      public: options.public,
    })
  }
}

// ─── MutationBuilder ──────────────────────────────────────────────────────────

type HttpMethod = "POST" | "PATCH" | "DELETE"

/**
 * An insert sent through `supatype.create_record` (one row) or `supatype.create_records` (several,
 * all or none) rather than as a plain `POST`: the table, which keeps drafts, and the key its new
 * records are read back by.
 *
 * Why at all: a new record on a drafts model is unpublished, and when the model's read rule hides
 * unpublished rows Postgres refuses an insert that asks for the row back, since it checks the
 * returned row against that rule before anything has made it visible to its author.
 * `create_record` inserts without reading back and writes version 1, after which the author sees it.
 */
export interface DraftCreate {
  readonly table: string
  readonly primaryKey: string
}

/**
 * An update sent through `supatype.save_drafts` rather than as a plain `PATCH`: the table, which
 * keeps drafts, its key, and whether to publish the new drafts in the same call.
 *
 * Why at all: on a drafts model the live row changes only by publishing, and the database refuses
 * a direct update of it from the API roles.
 */
export interface DraftEdit extends DraftCreate {
  readonly publish: boolean
}

/** How a write is made beyond its method and body. */
export interface MutationOptions {
  upsert?: boolean | undefined
  /** Create the records through `create_record` or `create_records`, for an insert on a drafts model. */
  createThrough?: DraftCreate | undefined
  /** Save a draft of each matched record through `save_drafts`, for an update on a drafts model. */
  editThrough?: DraftEdit | undefined
  /** Send nothing and answer with this: the write asks for something its table cannot do. */
  refusal?: SupatypeError | undefined
}

/**
 * The rows a write hands back for `select(columns)`.
 *
 * Read from the string, as `TableClient.select` does, when the builder knows the tables it was
 * written against. A builder constructed by hand knows only its row, so there it stays the row.
 */
type ReturnedRow<TRow, TTables, TName extends string, TColumns extends string> =
  [TTables] extends [Record<string, TableDef>] ? SelectRow<TTables, TName, TColumns> : TRow

export class MutationBuilder<TRow, TTables = unknown, TName extends string = string>
  extends FilterBuilder
  implements PromiseLike<QueryResult<TRow[]>> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly send: RequestTransport
  private readonly extraHeaders: Record<string, string>
  private readonly method: HttpMethod
  private readonly body: unknown
  private readonly createThrough: DraftCreate | undefined
  private readonly editThrough: DraftEdit | undefined
  private readonly refusal: SupatypeError | undefined

  constructor(
    baseUrl: string,
    path: string,
    headers: Record<string, string> | HeadersProvider,
    method: HttpMethod,
    body?: unknown,
    opts?: MutationOptions | undefined,
    onUnauthorized?: (() => Promise<void>) | undefined,
    transport: RequestTransport = plainFetch,
  ) {
    super()
    this.baseUrl = baseUrl
    this.path = path
    this.getHeaders = asHeadersProvider(headers)
    this.onUnauthorized = onUnauthorized
    this.send = transport
    this.extraHeaders = {}
    this.method = method
    this.body = body
    this.createThrough = opts?.createThrough
    this.editThrough = opts?.editThrough
    this.refusal = opts?.refusal

    if (opts?.upsert === true) this.prefer("resolution=merge-duplicates")
    // Return inserted/updated rows
    if (method !== "DELETE") this.prefer("return=representation")
  }

  private prefer(preference: string): void {
    const current = this.extraHeaders["Prefer"]
    if (current?.split(",").includes(preference) === true) return
    this.extraHeaders["Prefer"] = current === undefined ? preference : `${current},${preference}`
  }

  /**
   * Return the written rows, limited to `columns`.
   *
   * Asks for the representation too, which a delete does not by default: without it PostgREST
   * answers 204 and `delete().select()` returned no rows although it had deleted some.
   */
  select<TColumns extends string = "*">(
    columns?: TColumns | undefined,
  ): MutationBuilder<ReturnedRow<TRow, TTables, TName, TColumns>, TTables, TName>
  /** Return the written rows typed as `TResult`, for a shape the select string cannot describe. */
  select<TResult>(columns?: string | undefined): MutationBuilder<TResult, TTables, TName>
  // The same request, now described as returning the selected shape rather than the whole row. The
  // overloads above say which shape; the row type is the caller's claim, checked by nothing at
  // runtime, so the builder itself is returned rather than a copy that would split the request.
  select(columns?: string | undefined): MutationBuilder<unknown, TTables, TName> {
    this.params.set("select", columns ?? "*")
    this.prefer("return=representation")
    return this
  }

  async single(): Promise<QueryResult<TRow>> {
    const { data, error, count, meta } = await this._execute({
      Accept: "application/vnd.pgrst.object+json",
    })
    if (error !== null) return { data: null, error, count: null, ...(meta && { meta }) }
    const row = data?.[0] ?? null
    if (row === null) {
      return {
        data: null,
        error: notOneRow(),
        count: null,
        ...(meta && { meta }),
      }
    }
    return { data: row, error: null, count: 1, ...(meta && { meta }) }
  }

  async maybeSingle(): Promise<QueryResult<TRow | null>> {
    const { data, error, count, meta } = await this._execute({})
    if (error !== null) return { data: null, error, count: null, ...(meta && { meta }) }
    const row = data !== null && data.length > 0 ? (data[0] ?? null) : null
    return { data: row, error: null, count, ...(meta && { meta }) }
  }

  then<R1 = QueryResult<TRow[]>, R2 = never>(
    onfulfilled?: ((value: QueryResult<TRow[]>) => R1 | PromiseLike<R1>) | null | undefined,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null | undefined,
  ): PromiseLike<R1 | R2> {
    return this._execute().then(onfulfilled, onrejected)
  }

  /** POST, PATCH and DELETE: the transport applies the timeout and never retries them. */
  private requestInit(): RequestInit {
    return {
      method: this.method,
      // Not `JSON.stringify`: it throws on a bigint, so reading a row with a bigInt column and
      // writing it back would fail now that the generated types declare one.
      ...(this.body !== undefined && { body: stringifyWithBigInts(this.body) }),
    }
  }

  private async _execute(fetchHeaders: Record<string, string> = {}): Promise<QueryResult<TRow[]>> {
    if (this.refusal !== undefined) return { data: null, error: this.refusal, count: null }
    if (this.createThrough !== undefined) return this.createDraftRecords(this.createThrough)
    if (this.editThrough !== undefined) return this.saveDraftRecords(this.editThrough)
    const qs = this.params.toString()
    const url = `${this.baseUrl}${this.path}${qs ? `?${qs}` : ""}`
    const resolveRequestHeaders = async (): Promise<Record<string, string>> => ({
      ...(await this.getHeaders()),
      ...this.extraHeaders,
      ...fetchHeaders,
    })
    let res: Response
    try {
      res = await fetchWithOptional401Retry(this.send, url, this.requestInit(), resolveRequestHeaders, this.onUnauthorized)
    } catch (e) {
      return { data: null, error: transportFailure(e), count: null }
    }

    if (!res.ok) {
      const error = await readRefusal(res, "[supatype:mutation] request failed", async () => ({
        url,
        method: this.method,
        role: decodeJwtRoleFromAuthHeader(await resolveRequestHeaders()),
      }))
      return { data: null, error, count: null }
    }

    if (res.status === 204) {
      return { data: [], error: null, count: 0 }
    }

    // The returned representation of what was just written, so it needs the same care as a read.
    const result = readRows<TRow>(await res.text(), this.path, res.status, null)
    return result.data === null ? result : { ...result, count: result.data.length }
  }

  /**
   * Create the records as their first drafts, then read them back as an insert returns them.
   *
   * Read from the draft view, which has the table's row type: the live row of a new record holds no
   * locale yet, so reading the table would hand back empty translations for what was just written.
   * The select string applies as it would to the insert's own answer, and several rows come back in
   * the order they were sent.
   */
  private async createDraftRecords(target: DraftCreate): Promise<QueryResult<TRow[]>> {
    const { fn, data } = createCall(this.body)
    const keys = await this.callPublishing(fn, { model_table: target.table, data })
    if (!Array.isArray(keys)) return { data: null, error: keys, count: null }
    return this.readDrafts(target, keys)
  }

  /**
   * Save a draft of each record the filters match, publishing it too when asked, then read the
   * drafts back as an update returns its rows. The live rows are left to publishing.
   *
   * The records are the ones the caller reads in the table under the update's filters, as a `PATCH`
   * would match them, and `save_drafts` saves all of them or none.
   */
  private async saveDraftRecords(target: DraftEdit): Promise<QueryResult<TRow[]>> {
    const matched = await this.matchedKeys(target.primaryKey)
    if (!Array.isArray(matched)) return { data: null, error: matched, count: null }
    // A `PATCH` that matches nothing answers no rows, and so does this, having saved nothing.
    if (matched.length === 0) return { data: [], error: null, count: 0 }
    const body = { model_table: target.table, record_ids: matched, data: this.body, publish: target.publish }
    const keys = await this.callPublishing("save_drafts", body)
    if (!Array.isArray(keys)) return { data: null, error: keys, count: null }
    return this.readDrafts(target, keys)
  }

  /** The keys of the rows this write's filters match, read from the table as the caller. */
  private async matchedKeys(primaryKey: string): Promise<string[] | SupatypeError> {
    const params = new URLSearchParams(this.params)
    params.set("select", primaryKey)
    const url = `${this.baseUrl}${this.path}?${params.toString()}`
    let res: Response
    try {
      res = await fetchWithOptional401Retry(this.send, url, { method: "GET" }, this.getHeaders, this.onUnauthorized)
    } catch (e) {
      return transportFailure(e)
    }
    if (!res.ok) return readRefusal(res, "[supatype:mutation] reading the records to draft failed", async () => ({ url }))
    const rows = readRows<Record<string, unknown>>(await res.text(), this.path, res.status, null)
    if (rows.data === null) return rows.error ?? notRows(res.status)
    return rows.data.map((row) => String(row[primaryKey]))
  }

  /** `keys`' newest drafts, from the draft view, with this write's select and in the order given. */
  private async readDrafts(target: DraftCreate, keys: string[]): Promise<QueryResult<TRow[]>> {
    const select = readBackColumns(this.params.get("select"), target.primaryKey, keys.length)
    const result = await new QueryBuilder<Record<string, unknown>>(
      this.baseUrl,
      this.path,
      this.getHeaders,
      select,
      defaultQueryCache,
      this.onUnauthorized,
      { profile: DRAFT_SCHEMA },
      this.send,
    ).in(target.primaryKey, keys)
    if (result.data === null) return { ...result, data: null }
    const rows = callerRows<TRow>(inCreatedOrder(result.data, keys)) ?? []
    return { ...result, data: rows, count: rows.length }
  }

  /** Call the publishing function `fn` with `body`: the record keys it answers with, in order, or why not. */
  private async callPublishing(fn: string, body: Record<string, unknown>): Promise<string[] | SupatypeError> {
    const url = `${this.baseUrl}/rest/v1/rpc/${fn}`
    const init = { method: "POST", body: stringifyWithBigInts(body) }
    const resolveRequestHeaders = async (): Promise<Record<string, string>> => ({
      ...(await this.getHeaders()),
      "Content-Profile": PUBLISHING_SCHEMA,
    })
    let res: Response
    try {
      res = await fetchWithOptional401Retry(this.send, url, init, resolveRequestHeaders, this.onUnauthorized)
    } catch (e) {
      return transportFailure(e)
    }
    const table = body["model_table"]
    if (!res.ok) return readRefusal(res, `[supatype:mutation] ${fn} failed`, async () => ({ url, table }))
    const answer: unknown = await res.json().catch(() => null)
    return createdKeys(answer) ?? { message: `${fn} answered without the record ids`, status: res.status }
  }
}

// ─── StorageError ─────────────────────────────────────────────────────────────

export type { SupatypeError }
export type { QueryCacheOptions, CacheStatus } from "./query-cache.js"
export { QueryCache, defaultQueryCache } from "./query-cache.js"
