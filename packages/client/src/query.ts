import type { QueryResult, SupatypeError } from "./types.js"

// ─── QueryBuilder ─────────────────────────────────────────────────────────────

export class QueryBuilder<TRow> implements PromiseLike<QueryResult<TRow[]>> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly headers: Record<string, string>
  private readonly params: URLSearchParams

  constructor(
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
    columns?: string | undefined,
  ) {
    this.baseUrl = baseUrl
    this.path = path
    this.headers = { ...headers }
    this.params = new URLSearchParams()
    if (columns !== undefined) {
      this.params.set("select", columns)
    }
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

  contains(column: string, value: unknown): this {
    this.params.append(column, `cs.${JSON.stringify(value)}`)
    return this
  }

  containedBy(column: string, value: unknown): this {
    this.params.append(column, `cd.${JSON.stringify(value)}`)
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
    this.headers["Accept-Language"] = code
    return this
  }

  range(from: number, to: number): this {
    this.headers["Range"] = `${from}-${to}`
    this.headers["Range-Unit"] = "items"
    return this
  }

  /** Return a single row (errors if none or many found). */
  async single(): Promise<QueryResult<TRow>> {
    const headers = {
      ...this.headers,
      Accept: "application/vnd.pgrst.object+json",
    }
    const { data, error } = await this._fetch(headers)
    if (error !== null) return { data: null, error, count: null }
    return { data: data as unknown as TRow, error: null, count: 1 }
  }

  /** Return a single row or null (errors if many found). */
  async maybeSingle(): Promise<QueryResult<TRow | null>> {
    const { data, error, count } = await this._fetch(this.headers)
    if (error !== null) return { data: null, error, count: null }
    const rows = data as TRow[]
    const row = rows.length > 0 ? (rows[0] ?? null) : null
    return { data: row, error: null, count }
  }

  then<R1 = QueryResult<TRow[]>, R2 = never>(
    onfulfilled?: ((value: QueryResult<TRow[]>) => R1 | PromiseLike<R1>) | null | undefined,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null | undefined,
  ): PromiseLike<R1 | R2> {
    return this._fetch(this.headers).then(onfulfilled, onrejected)
  }

  private async _fetch(headers: Record<string, string>): Promise<QueryResult<TRow[]>> {
    const qs = this.params.toString()
    const url = `${this.baseUrl}${this.path}${qs ? `?${qs}` : ""}`
    let res: Response
    try {
      res = await fetch(url, { headers })
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

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Error" })) as Record<string, unknown>
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

    const json = await res.json() as TRow[]
    return { data: json, error: null, count }
  }
}

// ─── MutationBuilder ──────────────────────────────────────────────────────────

type HttpMethod = "POST" | "PATCH" | "DELETE"

export class MutationBuilder<TRow> implements PromiseLike<QueryResult<TRow[]>> {
  private readonly baseUrl: string
  private readonly path: string
  private readonly headers: Record<string, string>
  private readonly method: HttpMethod
  private readonly body: unknown
  private readonly params: URLSearchParams

  constructor(
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
    method: HttpMethod,
    body?: unknown,
    opts?: { upsert?: boolean | undefined } | undefined,
  ) {
    this.baseUrl = baseUrl
    this.path = path
    this.headers = { ...headers }
    this.method = method
    this.body = body
    this.params = new URLSearchParams()

    if (opts?.upsert === true) {
      this.headers["Prefer"] = "resolution=merge-duplicates"
    }

    // Return inserted/updated rows
    if (method !== "DELETE") {
      this.headers["Prefer"] = (this.headers["Prefer"] ?? "") + ",return=representation"
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

  then<R1 = QueryResult<TRow[]>, R2 = never>(
    onfulfilled?: ((value: QueryResult<TRow[]>) => R1 | PromiseLike<R1>) | null | undefined,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null | undefined,
  ): PromiseLike<R1 | R2> {
    return this._execute().then(onfulfilled, onrejected)
  }

  private async _execute(): Promise<QueryResult<TRow[]>> {
    const qs = this.params.toString()
    const url = `${this.baseUrl}${this.path}${qs ? `?${qs}` : ""}`
    let res: Response
    try {
      res = await fetch(url, {
        method: this.method,
        headers: this.headers,
        ...(this.body !== undefined && { body: JSON.stringify(this.body) }),
      })
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : "Network error" },
        count: null,
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: "Error" })) as Record<string, unknown>
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
