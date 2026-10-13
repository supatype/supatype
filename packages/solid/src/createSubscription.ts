import { createSignal, onMount, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyDatabase, SupatypeError } from "@supatype/client"
import { watchTable, type SubscriptionState, type TableWatchOptions } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"

/** Which changes to receive. The same options `watchTable` takes, since they go straight to it. */
export type SubscriptionOptions = TableWatchOptions

export interface SubscriptionResult<TRow> {
  data: Accessor<TRow[] | null>
  error: Accessor<SupatypeError | null>
  status: Accessor<SubscriptionState>
}

/**
 * Real-time subscription signals.
 *
 * The channel, the status and the row merge are `watchTable`'s, shared with the Vue and Svelte
 * bindings; this only puts what it reports into signals.
 */
export function createSubscription<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: SubscriptionOptions | undefined,
): SubscriptionResult<TRow> {
  const client = useSupatype<TDatabase>()
  const [data, setData] = createSignal<TRow[] | null>(null)
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const [status, setStatus] = createSignal<SubscriptionState>("connecting")

  onMount(() => {
    const unsubscribe = watchTable<TRow>(client.realtime, table, options, {
      rows: (rows) => setData(() => rows),
      status: (view) => {
        setStatus(view.status)
        setError(view.error)
      },
    })
    onCleanup(unsubscribe)
  })

  return { data, error, status }
}
