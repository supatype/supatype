import { createSignal, onMount, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyDatabase, ChannelSubscription, SupatypeError } from "@supatype/client"
import { watchChannel, type SubscriptionState } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"
import { createRealtimeConnection, type RealtimeConnectionResult } from "./createRealtimeConnection.js"

export interface ChannelResult extends RealtimeConnectionResult {
  /** This channel's join: "connecting", "connected", "disconnected" or "error". */
  status: Accessor<SubscriptionState>
  /** Why the server refused the join, while the status is "error"; null otherwise. */
  error: Accessor<SupatypeError | null>
}

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `createSubscription` (one table, one listener) cannot do.
 *
 * `setup` runs once on mount and receives the channel before it is subscribed. The channel is left
 * when the owner is disposed.
 */
export function createChannel<TRow = Record<string, unknown>, TDatabase extends AnyDatabase = AugmentedDatabase>(
  name: string,
  setup: (channel: ChannelSubscription<TRow>) => void,
): ChannelResult {
  const client = useSupatype<TDatabase>()
  const connection = createRealtimeConnection<TDatabase>()
  const [status, setStatus] = createSignal<SubscriptionState>("connecting")
  const [error, setError] = createSignal<SupatypeError | null>(null)

  onMount(() => {
    onCleanup(
      watchChannel<TRow>(client.realtime, name, setup, (view) => {
        setStatus(view.status)
        setError(view.error)
      }),
    )
  })

  return { status, error, ...connection }
}
