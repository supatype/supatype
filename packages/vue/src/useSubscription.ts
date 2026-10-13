import { ref, onMounted, onUnmounted, type Ref } from "vue"
import type { AugmentedDatabase, AnyDatabase, SupatypeError, RealtimeEvent } from "@supatype/client"
import { watchTable, type SubscriptionState, type TableWatchOptions } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"

export type SubscriptionEvent = RealtimeEvent

/** Which changes to receive. The same options `watchTable` takes, since they go straight to it. */
export type UseSubscriptionOptions = TableWatchOptions

export interface UseSubscriptionReturn<TRow> {
  data: Ref<TRow[] | null>
  error: Ref<SupatypeError | null>
  status: Ref<SubscriptionState>
}

/**
 * Real-time subscription composable.
 *
 * The channel, the status and the row merge are `watchTable`'s, shared with the Svelte and Solid
 * bindings; this only puts what it reports into refs.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useSubscription } from '@supatype/vue'
 *
 * const { data: messages, status } = useSubscription('messages', {
 *   event: '*',
 *   filter: 'room_id=eq.123',
 * })
 * </script>
 * ```
 */
export function useSubscription<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: UseSubscriptionOptions | undefined,
): UseSubscriptionReturn<TRow> {
  const client = useSupatype<TDatabase>()
  const data = ref<TRow[] | null>(null) as Ref<TRow[] | null>
  const error = ref<SupatypeError | null>(null)
  const status = ref<SubscriptionState>("connecting")

  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    unsubscribe = watchTable<TRow>(client.realtime, table, options, {
      rows: (rows) => {
        data.value = rows
      },
      status: (view) => {
        status.value = view.status
        error.value = view.error
      },
    })
  })

  onUnmounted(() => {
    unsubscribe?.()
  })

  return { data, error, status }
}
