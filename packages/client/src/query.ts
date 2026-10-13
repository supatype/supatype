import type { QueryCache, QueryCacheOptions, CacheStatus } from "./query-cache.js"
import { buildCacheKey, defaultQueryCache } from "./query-cache.js"
import type { MaskedField, QueryResult, SelectQueryOptions, SupatypeError } from "./types.js"
import { parseRowsExactly, tableFromPath } from "./exact-response.js"
import { stringifyWithBigInts } from "./exact-values.js"
import { FilterBuilder } from "./filters.js"
import { transportFailure } from "./errors.js"
import { plainFetch, type FetchOptions, type RequestTransport } from "./fetch-with-retry.js"

const DEBUG_AUTH =
  (typeof process !== "undefined" && process.env["NEXT_PUBLIC_SUPATYPE_DEBUG_AUTH"] === "1") ||
  (typeof process !== "undefined" && process.env["SUPATYPE_DEBUG_AUTH"] === "1")

function decodeJwtRoleFromAuthHeader(headers: Record<string, string>): string | null {
  const auth = headers["Authorization"] ?? headers["authorization"]
  if (auth === undefined || !auth.startsWith("Bearer ")) return null
  const token = auth.slice("Bearer ".length)
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
    this.params.append("order", `${column}.${dir}.${nulls}`)
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
    // Some proxies drop Accept and return a one-element array, unwrap.
    const row = (Array.isArray(data) ? data[0] : data) as TRow | undefined
    if (row === undefined) {
      return {
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
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
    const rows = data as TRow[]
    const row = rows.length > 0 ? (rows[0] ?? null) : null
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
    const resolveRequestHeaders = async (): Promise<Record<string, string>> => {
      const authHeaders = await this.getHeaders()
      return this.applyServerCacheHeader({ ...authHeaders, ...mergedExtra })
    }

    if (this.cacheOptions && !this.head) {
      const requestHeaders = await resolveRequestHeaders()
      const cacheKey = buildCacheKey("GET", url, requestHeaders, {
        partition: this.cacheOptions.key,
        public: this.cacheOptions.public,
      })
      const cached = this.queryCache.get<TRow[]>(cacheKey)
      if (cached) {
        return withMeta(cached, { cacheStatus: "HIT" })
      }
    }

    let res: Response
    try {
      res = await fetchWithOptional401Retry(
        this.send,
        url,
        { method },
        resolveRequestHeaders,
        this.onUnauthorized,
      )
    } catch (e) {
      return { data: null, error: transportFailure(e), count: null }
    }

    const count = parseContentRangeTotal(res.headers.get("content-range"))

    const maskedFields = parseMaskedFields(res.headers.get("X-Supatype-Masked-Fields"))
    const serverCacheStatus = res.headers.get("X-Supatype-Cache-Status") as CacheStatus | null
    const cacheStatus: CacheStatus =
      serverCacheStatus === "HIT" || serverCacheStatus === "MISS" || serverCacheStatus === "BYPASS"
        ? serverCacheStatus
        : this.cacheOptions
          ? "MISS"
          : undefined

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Error" })) as Record<string, unknown>
      const debugHeaders = await resolveRequestHeaders()
      if (DEBUG_AUTH) {
        console.log("[supatype:query] request failed", {
          url,
          status: res.status,
          role: decodeJwtRoleFromAuthHeader(debugHeaders),
          message: String(err["message"] ?? err["hint"] ?? "Request failed"),
          code: typeof err["code"] === "string" ? err["code"] : null,
        })
      }
      return withMeta<TRow[]>(
        {
          data: null,
          error: {
            message: String(err["message"] ?? err["hint"] ?? "Request failed"),
            status: res.status,
            ...(err["code"] !== undefined && { code: String(err["code"]) }),
            // A field validator's refusal names the column it refused. Kept whole rather than
            // folded into the message, so a form can mark the input.
            ...(typeof err["field"] === "string" && { field: err["field"] }),
          },
          count: null,
        },
        { cacheStatus, maskedFields },
      )
    }

    if (method === "HEAD" || res.status === 204) {
      return withMeta<TRow[]>(
        { data: null, error: null, count },
        { cacheStatus, maskedFields },
      )
    }

    // Read from the text rather than `res.json()`: a bigInt, decimal or money column is already
    // ruined by the time `JSON.parse` returns, and the digits are only recoverable from the body.
    const parsed = parseRowsExactly(await res.text(), tableFromPath(this.path))
    if (!parsed.ok) {
      return withMeta<TRow[]>(
        { data: null, error: { message: parsed.message, status: res.status }, count: null },
        { cacheStatus, maskedFields },
      )
    }

    const result: QueryResult<TRow[]> = { data: parsed.value as TRow[], error: null, count }

    if (this.cacheOptions) {
      const cacheKey = buildCacheKey("GET", url, await resolveRequestHeaders(), {
        partition: this.cacheOptions.key,
        public: this.cacheOptions.public,
      })
      this.queryCache.set(cacheKey, result, this.cacheOptions.ttl)
    }

    return withMeta(result, { cacheStatus, maskedFields })
  }
}

// ─── MutationBuilder ──────────────────────────────────────────────────────────

type HttpMethod = "POST" | "PATCH" | "DELETE"

export class MutationBuilder<TRow> extends FilterBuilder implements PromiseLike<QueryResult<TRow[]>> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly send: RequestTransport
  private readonly extraHeaders: Record<string, string>
  private readonly method: HttpMethod
  private readonly body: unknown

  constructor(
    baseUrl: string,
    path: string,
    headers: Record<string, string> | HeadersProvider,
    method: HttpMethod,
    body?: unknown,
    opts?: { upsert?: boolean | undefined } | undefined,
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
  select(columns?: string): this {
    this.params.set("select", columns ?? "*")
    this.prefer("return=representation")
    return this
  }

  async single(): Promise<QueryResult<TRow>> {
    const { data, error, count, meta } = await this._execute({
      Accept: "application/vnd.pgrst.object+json",
    })
    if (error !== null) return { data: null, error, count: null, ...(meta && { meta }) }
    const row = data !== null && data.length > 0 ? (data[0] as TRow) : null
    if (row === null) {
      return {
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned" },
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

  private async _execute(fetchHeaders: Record<string, string> = {}): Promise<QueryResult<TRow[]>> {
    const qs = this.params.toString()
    const url = `${this.baseUrl}${this.path}${qs ? `?${qs}` : ""}`
    const resolveRequestHeaders = async (): Promise<Record<string, string>> => ({
      ...(await this.getHeaders()),
      ...this.extraHeaders,
      ...fetchHeaders,
    })
    // POST, PATCH and DELETE: the transport applies the timeout and never retries them.
    const init: RequestInit = {
      method: this.method,
      // Not `JSON.stringify`: it throws on a bigint, so reading a row with a bigInt column and
      // writing it back would fail now that the generated types declare one.
      ...(this.body !== undefined && { body: stringifyWithBigInts(this.body) }),
    }
    let res: Response
    try {
      res = await fetchWithOptional401Retry(
        this.send,
        url,
        init,
        resolveRequestHeaders,
        this.onUnauthorized,
      )
    } catch (e) {
      return { data: null, error: transportFailure(e), count: null }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Error" })) as Record<string, unknown>
      if (DEBUG_AUTH) {
        console.log("[supatype:mutation] request failed", {
          url,
          method: this.method,
          status: res.status,
          role: decodeJwtRoleFromAuthHeader(await resolveRequestHeaders()),
          message: String(err["message"] ?? err["hint"] ?? "Request failed"),
          code: typeof err["code"] === "string" ? err["code"] : null,
        })
      }
      return {
        data: null,
        error: {
          message: String(err["message"] ?? err["hint"] ?? "Request failed"),
          status: res.status,
          ...(err["code"] !== undefined && { code: String(err["code"]) }),
        },
        count: null,
      }
    }

    if (res.status === 204) {
      return { data: [], error: null, count: 0 }
    }

    // The returned representation of what was just written, so it needs the same care as a read.
    const parsed = parseRowsExactly(await res.text(), tableFromPath(this.path))
    if (!parsed.ok) {
      return { data: null, error: { message: parsed.message, status: res.status }, count: null }
    }

    const data = Array.isArray(parsed.value) ? (parsed.value as TRow[]) : [parsed.value as TRow]
    return { data, error: null, count: data.length }
  }
}

// ─── StorageError ─────────────────────────────────────────────────────────────

export type { SupatypeError }
export type { QueryCacheOptions, CacheStatus } from "./query-cache.js"
export { QueryCache, defaultQueryCache } from "./query-cache.js"
