import { createSignal, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface QueryOptions {
  columns?: string | undefined
  filter?: Record<string, unknown> | undefined
  order?: { column: string; ascending?: boolean } | undefined
  limit?: number | undefined
  offset?: number | undefined
  enabled?: boolean | undefined
}

export interface QueryResult<TRow> {
  data: Accessor<TRow[] | null>
  error: Accessor<SupatypeError | null>
  loading: Accessor<boolean>
  refetch: () => Promise<void>
}

export function createQuery<
  TDatabase extends AnyDatabase = AnyDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: QueryOptions | undefined,
): QueryResult<TRow> {
  const client = useSupatype<TDatabase>()
  const [data, setData] = createSignal<TRow[] | null>(null)
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const [loading, setLoading] = createSignal(false)

  const fetchData = async () => {
    if (options?.enabled === false) return

    setLoading(true)
    setError(null)

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
      setData(() => result.data as TRow[] | null)
      if (result.error) {
        setError(result.error)
      }
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : "Unknown error" })
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    fetchData()
  })

  return { data, error, loading, refetch: fetchData }
}
