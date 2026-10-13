import { writable, type Readable } from "svelte/store"
import { onDestroy } from "svelte"
import {
  watchTable,
  type AugmentedDatabase,
  type AnyDatabase,
  type SupatypeError,
  type SubscriptionState,
  type TableWatchOptions,
} from "@supatype/client"
import { getSupatypeClient } from "./context.js"

/** Which changes to receive. The same options `watchTable` takes, since they go straight to it. */
export type SubscriptionOptions = TableWatchOptions

export interface SubscriptionStore<TRow> {
  data: Readable<TRow[] | null>
  error: Readable<SupatypeError | null>
  status: Readable<SubscriptionState>
}

/**
 * Real-time subscription stores.
 *
 * The channel, the status and the row merge are `watchTable`'s, shared with the Vue and Solid
 * bindings; this only puts what it reports into stores.
 */
export function createSubscription<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: SubscriptionOptions | undefined,
): SubscriptionStore<TRow> {
  const client = getSupatypeClient<TDatabase>()
  const data = writable<TRow[] | null>(null)
  const error = writable<SupatypeError | null>(null)
  const status = writable<SubscriptionState>("connecting")

  const unsubscribe = watchTable<TRow>(client.realtime, table, options, {
    rows: (rows) => data.set(rows),
    status: (view) => {
      status.set(view.status)
      error.set(view.error)
    },
  })

  onDestroy(unsubscribe)

  return {
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    status: { subscribe: status.subscribe },
  }
}
