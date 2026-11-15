import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyDatabase, ChannelSubscription, SupatypeError } from "@supatype/client"
import { channelSlot, type SubscriptionState } from "@supatype/client/bindings"
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
 * `name` may be a string or an accessor. `setup` runs on mount, and again on the new channel
 * whenever the accessor's value changes, after the old channel is left and its listeners with it.
 * The channel is left when the owner is disposed.
 */
export function createChannel<TRow = Record<string, unknown>, TDatabase extends AnyDatabase = AugmentedDatabase>(
  name: string | Accessor<string>,
  setup: (channel: ChannelSubscription<TRow>) => void,
): ChannelResult {
  const client = useSupatype<TDatabase>()
  const connection = createRealtimeConnection<TDatabase>()
  const [status, setStatus] = createSignal<SubscriptionState>("connecting")
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const slot = channelSlot<TRow>(client.realtime, setup, (view) => {
    setStatus(view.status)
    setError(view.error)
  })
  const current = (): string => (typeof name === "function" ? name() : name)

  onMount(() => {
    slot.join(current())
    onCleanup(slot.leave)
  })
  // Deferred, because `onMount` above makes the first join; `on` runs the move only when the name changes.
  createEffect(on(current, (next) => slot.join(next), { defer: true }))

  return { status, error, ...connection }
}
