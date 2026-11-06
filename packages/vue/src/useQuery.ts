import { ref, shallowRef, onMounted, onUnmounted, watch, type Ref } from "vue"
import type { AugmentedDatabase, AnyClient, AnyDatabase, SupatypeError } from "@supatype/client"
import { onIdentityChange } from "@supatype/client"
import { useSupatype } from "./context.js"
import { latestRowsReader } from "@supatype/client/bindings"

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
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: UseQueryOptions | undefined,
): UseQueryReturn<TRow> {
  const client = useSupatype<TDatabase>()
  const { data, error, loading, read } = latestRows<TRow>(client as AnyClient, table)
  const fetchData = async () => {
    if (isEnabled(options?.enabled)) await read(options)
  }

  onMounted(fetchData)

  // Re-run when the signed-in identity changes. See `onIdentityChange` for which changes count,
  // and why the fetch above is not enough on its own.
  onUnmounted(onIdentityChange(client.auth, () => void fetchData()))

  // Re-fetch when enabled changes
  if (options?.enabled && typeof options.enabled !== "boolean") {
    watch(options.enabled, (newVal) => {
      if (newVal) fetchData()
    })
  }

  return { data, error, loading, refetch: fetchData }
}

/** `enabled` as a plain boolean: a ref is read now, and absent means enabled. */
function isEnabled(enabled: Ref<boolean> | boolean | undefined): boolean {
  return enabled === undefined || (typeof enabled === "boolean" ? enabled : enabled.value)
}

/** The refs a query shows, fed by reads of which only the newest may change them. */
function latestRows<TRow>(client: AnyClient, table: string) {
  // Shallow: each fetch replaces the rows whole, and `ref` would type them as `UnwrapRef<TRow>`.
  const data = shallowRef<TRow[] | null>(null)
  const error = ref<SupatypeError | null>(null)
  const loading = ref(false)
  const read = latestRowsReader<TRow>(client, table, `useQuery("${table}")`, {
    started: () => {
      loading.value = true
      error.value = null
    },
    settled: (rows, refusal) => {
      data.value = rows
      error.value = refusal
      loading.value = false
    },
  })
  return { data, error, loading, read }
}
