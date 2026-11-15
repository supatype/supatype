import { ref, onMounted, onUnmounted, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue"
import type { AugmentedDatabase, AnyDatabase, ChannelActionRefusal, ChannelOptions, ChannelSubscription, SupatypeError } from "@supatype/client"
import { channelSlot, type SubscriptionState } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"
import { useRealtimeConnection, type UseRealtimeConnectionReturn } from "./useRealtimeConnection.js"

export interface UseChannelReturn extends UseRealtimeConnectionReturn {
  /** This channel's join: "connecting", "connected", "disconnected" or "error". */
  status: Ref<SubscriptionState>
  /** Why the server refused the join, while the status is "error"; null otherwise. */
  error: Ref<SupatypeError | null>
  /** The latest send, track or payload the server refused on this channel; the status does not move for it. */
  refusal: Ref<ChannelActionRefusal | null>
}

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `useSubscription` (one table, one listener) cannot do.
 *
 * `name` may be a string, a ref or a getter. `setup` runs on mount, and again on the new channel
 * whenever the name changes, after the old channel is left and its listeners with it. The channel
 * is left when the component unmounts.
 *
 * `options.private` asks for a private channel (a schema `Channel` declaration guards it): see
 * `ChannelOptions`. A refused or withdrawn join shows as `error`, a `RealtimeChannelError` whose `reason`
 * says why.
 *
 * @example
 * ```ts
 * const { status, isConnected } = useChannel(() => `auction:${props.id}`, (channel) => {
 *   channel.on("postgres_changes", { event: "INSERT", table: "bid" }, (p) => bids.value.push(p.new))
 *   channel.onBroadcast("outbid", (p) => notify(p))
 * })
 * ```
 */
export function useChannel<TRow = Record<string, unknown>, TDatabase extends AnyDatabase = AugmentedDatabase>(
  name: MaybeRefOrGetter<string>,
  setup: (channel: ChannelSubscription<TRow>) => void,
  options?: ChannelOptions | undefined,
): UseChannelReturn {
  const client = useSupatype<TDatabase>()
  const connection = useRealtimeConnection<TDatabase>()
  const status = ref<SubscriptionState>("connecting")
  const error = ref<SupatypeError | null>(null)
  const refusal = ref<ChannelActionRefusal | null>(null)
  const slot = channelSlot<TRow>(client.realtime, setup, (view) => {
    status.value = view.status
    error.value = view.error
    if (view.status === "connecting") refusal.value = null
  }, options, (refused) => {
    refusal.value = refused
  })
  let mounted = false

  onMounted(() => {
    mounted = true
    slot.join(toValue(name))
  })
  watch(() => toValue(name), (next) => {
    if (mounted) slot.join(next)
  })
  onUnmounted(() => {
    mounted = false
    slot.leave()
  })

  return { status, error, refusal, ...connection }
}
