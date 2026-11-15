import { writable, type Readable } from "svelte/store"
import { onDestroy } from "svelte"
import type { AugmentedDatabase, AnyDatabase, ChannelActionRefusal, ChannelOptions, ChannelSubscription, SupatypeError } from "@supatype/client"
import { channelSlot, type SubscriptionState } from "@supatype/client/bindings"
import { getSupatypeClient } from "./context.js"
import { createRealtimeConnection, type RealtimeConnectionStore } from "./createRealtimeConnection.js"

export interface ChannelStore extends RealtimeConnectionStore {
  /** This channel's join: "connecting", "connected", "disconnected" or "error". */
  status: Readable<SubscriptionState>
  /** Why the server refused the join, while the status is "error"; null otherwise. */
  error: Readable<SupatypeError | null>
  /** The latest send, track or payload the server refused on this channel; the status does not move for it. */
  refusal: Readable<ChannelActionRefusal | null>
}

/** A name given as a store, told apart from a plain string by its `subscribe`. */
function isReadable(name: string | Readable<string>): name is Readable<string> {
  return typeof name !== "string"
}

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `createSubscription` (one table, one listener) cannot do.
 *
 * `name` may be a string or a store. `setup` runs straight away, and again on the new channel
 * whenever the store changes, after the old channel is left and its listeners with it. The channel
 * is left when the component is destroyed. With runes, `toStore(() => name)` from `svelte/store`
 * turns reactive state into a store.
 *
 * `options.private` asks for a private channel (a schema `Channel` declaration guards it): see
 * `ChannelOptions`. A refused or withdrawn join shows as `error`, a `RealtimeChannelError` whose `reason`
 * says why.
 */
export function createChannel<TRow = Record<string, unknown>, TDatabase extends AnyDatabase = AugmentedDatabase>(
  name: string | Readable<string>,
  setup: (channel: ChannelSubscription<TRow>) => void,
  options?: ChannelOptions | undefined,
): ChannelStore {
  const client = getSupatypeClient<TDatabase>()
  const connection = createRealtimeConnection<TDatabase>()
  const status = writable<SubscriptionState>("connecting")
  const error = writable<SupatypeError | null>(null)
  const refusal = writable<ChannelActionRefusal | null>(null)
  const slot = channelSlot<TRow>(client.realtime, setup, (view) => {
    status.set(view.status)
    error.set(view.error)
    if (view.status === "connecting") refusal.set(null)
  }, options, (refused) => {
    refusal.set(refused)
  })

  // A store calls a new subscriber at once with its value, which is the first join.
  if (isReadable(name)) onDestroy(name.subscribe((next) => slot.join(next)))
  else slot.join(name)
  onDestroy(slot.leave)

  return {
    status: { subscribe: status.subscribe },
    error: { subscribe: error.subscribe },
    refusal: { subscribe: refusal.subscribe },
    ...connection,
  }
}
