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
