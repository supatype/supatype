import { writable, type Readable } from "svelte/store"
import { onDestroy } from "svelte"
import type { AugmentedDatabase, AnyDatabase, ChannelSubscription, SupatypeError } from "@supatype/client"
import { watchChannel, type SubscriptionState } from "@supatype/client/bindings"
import { getSupatypeClient } from "./context.js"
import { createRealtimeConnection, type RealtimeConnectionStore } from "./createRealtimeConnection.js"

export interface ChannelStore extends RealtimeConnectionStore {
  /** This channel's join: "connecting", "connected", "disconnected" or "error". */
  status: Readable<SubscriptionState>
  /** Why the server refused the join, while the status is "error"; null otherwise. */
  error: Readable<SupatypeError | null>
}

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `createSubscription` (one table, one listener) cannot do.
 *
 * `setup` runs straight away and receives the channel before it is subscribed. The channel is left
 * when the component is destroyed.
 */
export function createChannel<TRow = Record<string, unknown>, TDatabase extends AnyDatabase = AugmentedDatabase>(
  name: string,
  setup: (channel: ChannelSubscription<TRow>) => void,
): ChannelStore {
  const client = getSupatypeClient<TDatabase>()
  const connection = createRealtimeConnection<TDatabase>()
  const status = writable<SubscriptionState>("connecting")
  const error = writable<SupatypeError | null>(null)

  onDestroy(
    watchChannel<TRow>(client.realtime, name, setup, (view) => {
      status.set(view.status)
      error.set(view.error)
    }),
  )

  return { status: { subscribe: status.subscribe }, error: { subscribe: error.subscribe }, ...connection }
}
