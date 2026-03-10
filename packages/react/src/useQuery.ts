import { useState, useEffect, useCallback, useRef } from "react"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface UseQueryOptions {
  /** PostgREST select expression (default: '*') */
  select?: string | undefined
  /** Simple equality filters keyed by column name */
  filter?: Record<string, unknown> | undefined
  /** Column to order by */
  order?: { column: string; ascending?: boolean | undefined } | undefined
  /** Maximum number of rows to return */
  limit?: number | undefined
  /** Row offset (for pagination) */
  offset?: number | undefined
  /** Set to false to skip the query (useful for conditional fetching) */
  enabled?: boolean | undefined
  /** Re-fetch interval in milliseconds */
  refetchInterval?: number | undefined
}

export interface UseQueryResult<TRow> {
  data: TRow[] | null
  error: SupatypeError | null
  count: number | null
  loading: boolean
  refetch(): void
}

/**
 * Fetch rows from a table with automatic re-execution when options change.
 *
 * @example
 * ```tsx
 * const { data: posts, loading } = useQuery('posts', {
 *   filter: { status: 'published' },
 *   order: { column: 'created_at', ascending: false },
 *   limit: 10,
 * })
 * ```
 */
export function useQuery<
  TDatabase extends AnyDatabase = AnyDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: UseQueryOptions | undefined,
): UseQueryResult<TRow> {
  const client = useSupatype<TDatabase>()
  const [data, setData] = useState<TRow[] | null>(null)
  const [error, setError] = useState<SupatypeError | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  // Stable reference to options for the effect dep
  const optionsJson = JSON.stringify(options)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const execute = useCallback(async () => {
    if (options?.enabled === false) {
      setLoading(false)
      return
    }
    setLoading(true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = (client.from(table) as any).select(options?.select ?? "*")

    if (options?.filter !== undefined) {
      for (const [col, val] of Object.entries(options.filter)) {
        query = query.eq(col, val)
      }
    }
    if (options?.order !== undefined) {
      query = query.order(options.order.column, { ascending: options.order.ascending ?? true })
    }
    if (options?.limit !== undefined) {
      query = query.limit(options.limit)
    }
    if (options?.offset !== undefined && options.limit !== undefined) {
      query = query.range(options.offset, options.offset + options.limit - 1)
    }

    const result = (await query) as { data: TRow[] | null; error: SupatypeError | null; count: number | null }
    setData(result.data)
    setError(result.error)
    setCount(result.count)
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, table, optionsJson])

  useEffect(() => {
    void execute()

    if (options?.refetchInterval !== undefined) {
      intervalRef.current = setInterval(() => void execute(), options.refetchInterval)
    }
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execute])

  return { data, error, count, loading, refetch: () => void execute() }
}
