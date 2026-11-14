import type { ChannelSubscription, RealtimeClient, RealtimeConnectionState } from "./realtime.js"
import { subscriptionViewOf, type SubscriptionView } from "./table-subscription.js"

/**
 * One channel with any number of listeners, and the socket's own state, for the Vue, Svelte and
 * Solid bindings. Each binding is only the adapter between these and its framework's state, as it
 * is for `watchTable`; React's `useChannel` reads the same two client signals directly.
 */

/**
 * Join the channel `name`, let `setup` add its listeners first, and report each status as the
 * binding's view of it. Returns the unsubscribe.
 */
export function watchChannel<TRow = Record<string, unknown>>(
  realtime: RealtimeClient,
  name: string,
  setup: (channel: ChannelSubscription<TRow>) => void,
  onStatus: (view: SubscriptionView) => void,
): () => void {
  const channel = realtime.channel<TRow>(name)
  setup(channel)
  channel.subscribe((status, err) => onStatus(subscriptionViewOf(status, err)))
  return () => channel.unsubscribe()
}

/**
 * Report the socket's state now and at each change. Returns the unsubscribe.
 *
 * The state is reported straight away because a binding mounting after the socket opened would
 * otherwise show "disconnected" until the next change.
 */
export function watchConnection(
  realtime: RealtimeClient,
  onChange: (state: RealtimeConnectionState) => void,
): () => void {
  onChange(realtime.connectionState)
  return realtime.onConnectionChange(onChange)
}

/** One channel at a time, which can be moved to another name. */
export interface ChannelSlot {
  /** Join `name`, leaving the channel held first. Joining the name already held does nothing. */
  join(name: string): void
  /** Leave the channel held, if any. */
  leave(): void
}

/**
 * A binding's channel when its name can change: the old channel is left, its listeners go with it,
 * `setup` runs on the new one, and the status reads "connecting" until it joins. A binding calls
 * `join` for the first name and again for each change, and `leave` when it is torn down.
 */
export function channelSlot<TRow = Record<string, unknown>>(
  realtime: RealtimeClient,
  setup: (channel: ChannelSubscription<TRow>) => void,
  onStatus: (view: SubscriptionView) => void,
): ChannelSlot {
  let held: { name: string; stop: () => void } | null = null
  const leave = (): void => {
    held?.stop()
    held = null
  }
  return {
    join(name) {
      if (held?.name === name) return
      if (held !== null) onStatus({ status: "connecting", error: null })
      leave()
      held = { name, stop: watchChannel<TRow>(realtime, name, setup, onStatus) }
    },
    leave,
  }
}
