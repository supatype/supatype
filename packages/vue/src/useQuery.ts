import { ref, onMounted, watch, type Ref } from "vue"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface UseQueryOptions {
  columns?: string | undefined
  filter?: Record<string, unknown> | undefined
  order?: { column: string; ascending?: boolean } | undefined
  limit?: number | undefined
  offset?: number | undefined
  enabled?: Ref<boolean> | boolean | undefined
}

export interface UseQueryReturn<TRow> {
  data: Ref<TRow[] | null>
  error: Ref<SupatypeError | null>
  loading: Ref<boolean>
  refetch: () => Promise<void>
}

/**
 * Reactive data fetching composable for Supatype tables.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useQuery } from '@supatype/vue'
 *
 * const { data: posts, loading, error, refetch } = useQuery('posts', {
 *   order: { column: 'created_at', ascending: false },
 *   limit: 10,
 * })
 * </script>
 * ```
 */
export function useQuery<
  TDatabase extends AnyDatabase = AnyDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: UseQueryOptions | undefined,
): UseQueryReturn<TRow> {
  const client = useSupatype<TDatabase>()
  const data = ref<TRow[] | null>(null) as Ref<TRow[] | null>
  const error = ref<SupatypeError | null>(null)
  const loading = ref(false)

  const fetchData = async () => {
    // Check enabled
    const enabled = options?.enabled
    if (enabled !== undefined) {
      const isEnabled = typeof enabled === "boolean" ? enabled : enabled.value
      if (!isEnabled) return
    }

    loading.value = true
    error.value = null

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
      data.value = result.data as TRow[] | null
      if (result.error) {
        error.value = result.error
      }
    } catch (e) {
      error.value = { message: e instanceof Error ? e.message : "Unknown error" }
    } finally {
      loading.value = false
    }
  }

  onMounted(fetchData)

  // Re-fetch when enabled changes
  if (options?.enabled && typeof options.enabled !== "boolean") {
    watch(options.enabled, (newVal) => {
      if (newVal) fetchData()
    })
  }

  return { data, error, loading, refetch: fetchData }
}
