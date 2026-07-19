import type { QueryCache, QueryCacheOptions, CacheStatus } from "./query-cache.js"
import { buildCacheKey, defaultQueryCache } from "./query-cache.js"
import type { QueryResult, SelectQueryOptions, SupatypeError } from "./types.js"

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

function withCacheMeta<T>(
  result: QueryResult<T>,
  cacheStatus?: CacheStatus,
): QueryResult<T> {
  if (cacheStatus === undefined) return result
  return {
    ...result,
    meta: { ...(result.meta ?? {}), cacheStatus },
  }
}

/** Resolves auth (and other) headers at request time so token refresh can run first. */
export type HeadersProvider = () => Promise<Record<string, string>>

function asHeadersProvider(
  headers: Record<string, string> | HeadersProvider,
): HeadersProvider {
  if (typeof headers === "function") return headers
  return () => Promise.resolve(headers)
}

async function fetchWithOptional401Retry(
  url: string,
  init: RequestInit,
  resolveHeaders: () => Promise<Record<string, string>>,
  onUnauthorized?: (() => Promise<void>) | undefined,
): Promise<Response> {
  let headers = await resolveHeaders()
  let res = await fetch(url, { ...init, headers })
  if (res.status === 401 && onUnauthorized !== undefined) {
    await onUnauthorized()
    headers = await resolveHeaders()
    res = await fetch(url, { ...init, headers })
  }
  return res
}

// ─── QueryBuilder ─────────────────────────────────────────────────────────────

export class QueryBuilder<TRow> implements PromiseLike<QueryResult<TRow[]>> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly extraHeaders: Record<string, string>
  private readonly params: URLSearchParams
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
  ) {
    this.baseUrl = baseUrl
    this.path = path
    this.getHeaders = asHeadersProvider(headers)
    this.onUnauthorized = onUnauthorized
    this.extraHeaders = {}
    this.params = new URLSearchParams()
    this.queryCache = queryCache
    this.countMode = selectOptions?.count
    this.head = selectOptions?.head === true
    if (columns !== undefined) {
      this.params.set("select", columns)
    }
    if (this.countMode !== undefined) {
      this.extraHeaders["Prefer"] = `count=${this.countMode}`
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

  eq(column: string, value: unknown): this {
    this.params.append(column, `eq.${String(value)}`)
    return this
  }

  neq(column: string, value: unknown): this {
    this.params.append(column, `neq.${String(value)}`)
    return this
  }

  gt(column: string, value: unknown): this {
    this.params.append(column, `gt.${String(value)}`)
    return this
  }

  gte(column: string, value: unknown): this {
    this.params.append(column, `gte.${String(value)}`)
    return this
  }

  lt(column: string, value: unknown): this {
    this.params.append(column, `lt.${String(value)}`)
    return this
  }

  lte(column: string, value: unknown): this {
    this.params.append(column, `lte.${String(value)}`)
    return this
  }

  like(column: string, pattern: string): this {
    this.params.append(column, `like.${pattern}`)
    return this
  }

  ilike(column: string, pattern: string): this {
    this.params.append(column, `ilike.${pattern}`)
    return this
  }

  in(column: string, values: unknown[]): this {
    this.params.append(column, `in.(${values.map(String).join(",")})`)
    return this
  }

  is(column: string, value: null | boolean): this {
    this.params.append(column, `is.${String(value)}`)
    return this
  }

  not(column: string, op: string, value: unknown): this {
    this.params.append(column, `not.${op}.${String(value)}`)
    return this
  }

  contains(column: string, value: unknown): this {
    this.params.append(column, `cs.${JSON.stringify(value)}`)
    return this
  }

  containedBy(column: string, value: unknown): this {
    this.params.append(column, `cd.${JSON.stringify(value)}`)
    return this
  }

  /** PostgREST OR filter — pass conditions in PostgREST syntax, e.g. `"status.eq.active,owner_id.eq.123"`. */
  or(filters: string): this {
    this.params.append("or", `(${filters})`)
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
    return { data: data as unknown as TRow, error: null, count: 1, ...(meta && { meta }) }
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
        return withCacheMeta(cached, "HIT")
      }
    }

    let res: Response
    try {
      res = await fetchWithOptional401Retry(
        url,
        { method },
        resolveRequestHeaders,
        this.onUnauthorized,
      )
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : "Network error" },
        count: null,
      }
    }

    const contentRange = res.headers.get("content-range")
    const count =
      contentRange !== null
        ? parseInt(contentRange.split("/")[1] ?? "0", 10)
        : null

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
      return withCacheMeta<TRow[]>(
        {
          data: null,
          error: {
            message: String(err["message"] ?? err["hint"] ?? "Request failed"),
            status: res.status,
            ...(err["code"] !== undefined && { code: String(err["code"]) }),
          },
          count: null,
        },
        cacheStatus,
      )
    }

    if (method === "HEAD" || res.status === 204) {
      return withCacheMeta<TRow[]>(
        { data: null, error: null, count },
        cacheStatus,
      )
    }

    const json = await res.json() as TRow[]
    const result: QueryResult<TRow[]> = { data: json, error: null, count }

    if (this.cacheOptions) {
      const cacheKey = buildCacheKey("GET", url, await resolveRequestHeaders(), {
        partition: this.cacheOptions.key,
        public: this.cacheOptions.public,
      })
      this.queryCache.set(cacheKey, result, this.cacheOptions.ttl)
    }

    return withCacheMeta(result, cacheStatus)
  }
}

// ─── MutationBuilder ──────────────────────────────────────────────────────────

type HttpMethod = "POST" | "PATCH" | "DELETE"

export class MutationBuilder<TRow> implements PromiseLike<QueryResult<TRow[]>> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly getHeaders: HeadersProvider
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private readonly extraHeaders: Record<string, string>
  private readonly method: HttpMethod
  private readonly body: unknown
  private readonly params: URLSearchParams

  constructor(
    baseUrl: string,
    path: string,
    headers: Record<string, string> | HeadersProvider,
    method: HttpMethod,
    body?: unknown,
    opts?: { upsert?: boolean | undefined } | undefined,
    onUnauthorized?: (() => Promise<void>) | undefined,
  ) {
    this.baseUrl = baseUrl
    this.path = path
    this.getHeaders = asHeadersProvider(headers)
    this.onUnauthorized = onUnauthorized
    this.extraHeaders = {}
    this.method = method
    this.body = body
    this.params = new URLSearchParams()

    if (opts?.upsert === true) {
      this.extraHeaders["Prefer"] = "resolution=merge-duplicates"
    }

    // Return inserted/updated rows
    if (method !== "DELETE") {
      this.extraHeaders["Prefer"] = (this.extraHeaders["Prefer"] ?? "") + ",return=representation"
    }
  }

  eq(column: string, value: unknown): this {
    this.params.append(column, `eq.${String(value)}`)
    return this
  }

  neq(column: string, value: unknown): this {
    this.params.append(column, `neq.${String(value)}`)
    return this
  }

  in(column: string, values: unknown[]): this {
    this.params.append(column, `in.(${values.map(String).join(",")})`)
    return this
  }

  /** Limit returned columns on the mutation response (requires `return=representation`). */
  select(columns?: string): this {
    this.params.set("select", columns ?? "*")
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
    const init: RequestInit = {
      method: this.method,
      ...(this.body !== undefined && { body: JSON.stringify(this.body) }),
    }
    let res: Response
    try {
      res = await fetchWithOptional401Retry(
        url,
        init,
        resolveRequestHeaders,
        this.onUnauthorized,
      )
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : "Network error" },
        count: null,
      }
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

    const json = await res.json() as TRow | TRow[]
    const data = Array.isArray(json) ? json : [json]
    return { data, error: null, count: data.length }
  }
}

// ─── StorageError ─────────────────────────────────────────────────────────────

export type { SupatypeError }
export type { QueryCacheOptions, CacheStatus } from "./query-cache.js"
export { QueryCache, defaultQueryCache } from "./query-cache.js"
