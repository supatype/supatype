import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyDatabase, ChannelActionRefusal, ChannelName, ChannelOptions, ChannelSubscription, SupatypeError } from "@supatype/client"
import { channelSlot, type SubscriptionState } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"
import { createRealtimeConnection, type RealtimeConnectionResult } from "./createRealtimeConnection.js"

export interface ChannelResult extends RealtimeConnectionResult {
  /** This channel's join: "connecting", "connected", "disconnected" or "error". */
  status: Accessor<SubscriptionState>
  /** Why the server refused the join, while the status is "error"; null otherwise. */
  error: Accessor<SupatypeError | null>
  /** The latest send, track or payload the server refused on this channel; the status does not move for it. */
  refusal: Accessor<ChannelActionRefusal | null>
}

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `createSubscription` (one table, one listener) cannot do.
 *
 * `name` may be a string or an accessor. `setup` runs on mount, and again on the new channel
 * whenever the accessor's value changes, after the old channel is left and its listeners with it.
 * The channel is left when the owner is disposed.
 *
 * `options.private` asks for a private channel (a schema `Channel` declaration guards it): see
 * `ChannelOptions`. A refused or withdrawn join shows as `error`, a `RealtimeChannelError` whose `reason`
 * says why.
 */
export function createChannel<TRow = Record<string, unknown>, TDatabase extends AnyDatabase = AugmentedDatabase>(
  name: ChannelName | Accessor<ChannelName>,
  setup: (channel: ChannelSubscription<TRow>) => void,
  options?: ChannelOptions | undefined,
): ChannelResult {
  const client = useSupatype<TDatabase>()
  const connection = createRealtimeConnection<TDatabase>()
  const [status, setStatus] = createSignal<SubscriptionState>("connecting")
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const [refusal, setRefusal] = createSignal<ChannelActionRefusal | null>(null)
  const slot = channelSlot<TRow>(client.realtime, setup, (view) => {
    setStatus(view.status)
    setError(view.error)
    if (view.status === "connecting") setRefusal(null)
  }, options, (refused) => {
    setRefusal(refused)
  })
  const current = (): ChannelName => (typeof name === "function" ? name() : name)

  onMount(() => {
    slot.join(current())
    onCleanup(slot.leave)
  })
  // Deferred, because `onMount` above makes the first join; `on` runs the move only when the name changes.
  createEffect(on(current, (next) => slot.join(next), { defer: true }))

  return { status, error, refusal, ...connection }
}
