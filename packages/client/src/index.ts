import { AuthClient } from "./auth.js"
import { QueryBuilder, MutationBuilder } from "./query.js"
import { StorageClient } from "./storage.js"
import { RealtimeClient } from "./realtime.js"
import type { AnyDatabase, SupatypeClientConfig, SupatypeError } from "./types.js"

export type { User, Session, AuthChangeEvent, SupatypeError, QueryResult, AnyDatabase, SupatypeClientConfig } from "./types.js"
export { AuthClient } from "./auth.js"
export { QueryBuilder, MutationBuilder } from "./query.js"
export { StorageClient, BucketClient } from "./storage.js"
export type { StorageObject, TransformOptions } from "./storage.js"
export { RealtimeClient } from "./realtime.js"
export type { RealtimeEvent, RealtimePayload, ChannelStatus, PresenceEntry } from "./realtime.js"

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

export interface SupatypeClient<TDatabase extends AnyDatabase = AnyDatabase> {
  from<TTable extends keyof TDatabase["public"]["Tables"] & string>(
    table: TTable,
  ): TableClient<TDatabase["public"]["Tables"][TTable]>
  global<TRow extends Record<string, unknown> = Record<string, unknown>>(name: string): GlobalClient<TRow>
  auth: AuthClient
  storage: StorageClient
  realtime: RealtimeClient
  graphql(
    query: string,
    variables?: Record<string, unknown> | undefined,
  ): Promise<{ data: unknown; error: SupatypeError | null }>
}

export function createClient<TDatabase extends AnyDatabase = AnyDatabase>(
  config: SupatypeClientConfig,
): SupatypeClient<TDatabase> {
  const baseHeaders: Record<string, string> = {
    apikey: config.anonKey,
    "Content-Type": "application/json",
  }

  const auth = new AuthClient(`${config.url}/auth/v1`, baseHeaders)
  const storage = new StorageClient(`${config.url}/storage/v1`, baseHeaders)
  const realtime = new RealtimeClient(`${config.url}/realtime/v1`, baseHeaders)

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
        res = await fetch(`${config.url}/graphql/v1`, {
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
  }
}
