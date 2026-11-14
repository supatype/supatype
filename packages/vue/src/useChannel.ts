import { ref, onMounted, onUnmounted, type Ref } from "vue"
import type { AugmentedDatabase, AnyDatabase, ChannelSubscription, SupatypeError } from "@supatype/client"
import { watchChannel, type SubscriptionState } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"
import { useRealtimeConnection, type UseRealtimeConnectionReturn } from "./useRealtimeConnection.js"

export interface UseChannelReturn extends UseRealtimeConnectionReturn {
  /** This channel's join: "connecting", "connected", "disconnected" or "error". */
  status: Ref<SubscriptionState>
  /** Why the server refused the join, while the status is "error"; null otherwise. */
  error: Ref<SupatypeError | null>
}

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `useSubscription` (one table, one listener) cannot do.
 *
 * `setup` runs once on mount and receives the channel before it is subscribed. The channel is left
 * when the component unmounts.
 *
 * @example
 * ```ts
 * const { status, isConnected } = useChannel("auction:42", (channel) => {
 *   channel.on("postgres_changes", { event: "INSERT", table: "bid" }, (p) => bids.value.push(p.new))
 *   channel.onBroadcast("outbid", (p) => notify(p))
 * })
 * ```
 */
export function useChannel<TRow = Record<string, unknown>, TDatabase extends AnyDatabase = AugmentedDatabase>(
  name: string,
  setup: (channel: ChannelSubscription<TRow>) => void,
): UseChannelReturn {
  const client = useSupatype<TDatabase>()
  const connection = useRealtimeConnection<TDatabase>()
  const status = ref<SubscriptionState>("connecting")
  const error = ref<SupatypeError | null>(null)
  let stop: (() => void) | null = null

  onMounted(() => {
    stop = watchChannel<TRow>(client.realtime, name, setup, (view) => {
      status.value = view.status
      error.value = view.error
    })
  })
  onUnmounted(() => stop?.())

  return { status, error, ...connection }
}
