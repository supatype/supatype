import { writable, type Readable } from "svelte/store"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { getSupatypeClient } from "./context.js"

export interface QueryOptions {
  columns?: string | undefined
  filter?: Record<string, unknown> | undefined
  order?: { column: string; ascending?: boolean } | undefined
  limit?: number | undefined
  offset?: number | undefined
  enabled?: boolean | undefined
}

export interface QueryStore<TRow> {
  data: Readable<TRow[] | null>
  error: Readable<SupatypeError | null>
  loading: Readable<boolean>
  refetch: () => Promise<void>
}

export function createQuery<
  TDatabase extends AnyDatabase = AnyDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: QueryOptions | undefined,
): QueryStore<TRow> {
  const client = getSupatypeClient<TDatabase>()
  const data = writable<TRow[] | null>(null)
  const error = writable<SupatypeError | null>(null)
  const loading = writable(false)

  const fetchData = async () => {
    if (options?.enabled === false) return

    loading.set(true)
    error.set(null)

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (client.from(table) as any).select(options?.columns)

      if (options?.filter) {
        for (const [col, val] of Object.entries(options.filter)) {
          query = query.eq(col, val)
        }
      }

      if (options?.order) {
        query = query.order(options.order.column, {
          ascending: options.order.ascending ?? true,
        })
      }

      if (options?.limit !== undefined) {
        query = query.limit(options.limit)
      }

      if (options?.offset !== undefined) {
        query = query.range(options.offset, options.offset + (options.limit ?? 100) - 1)
      }

      const result = await query
      data.set(result.data as TRow[] | null)
      if (result.error) {
        error.set(result.error)
      }
    } catch (e) {
      error.set({ message: e instanceof Error ? e.message : "Unknown error" })
    } finally {
      loading.set(false)
    }
  }

  // Auto-fetch on creation
  fetchData()

  return {
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    loading: { subscribe: loading.subscribe },
    refetch: fetchData,
  }
}
