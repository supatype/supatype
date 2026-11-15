import { computed, ref, onMounted, onUnmounted, type ComputedRef, type Ref } from "vue"
import type { AugmentedDatabase, AnyDatabase, RealtimeConnectionState } from "@supatype/client"
import { watchConnection } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"

export interface UseRealtimeConnectionReturn {
  /** "connecting" covers the first connect, a reconnect after a drop, and the sign-in swap. */
  connectionState: Ref<RealtimeConnectionState>
  /** True while the realtime socket is open. A channel may still be waiting on its join. */
  isConnected: ComputedRef<boolean>
}

/**
 * The realtime socket's own state, which no channel status reports: a drop and a first connect both
 * read "connecting" on a channel. Reported by `watchConnection`, shared with Svelte and Solid.
 */
export function useRealtimeConnection<TDatabase extends AnyDatabase = AugmentedDatabase>(): UseRealtimeConnectionReturn {
  const client = useSupatype<TDatabase>()
  const connectionState = ref<RealtimeConnectionState>(client.realtime.connectionState)
  let stop: (() => void) | null = null

  onMounted(() => {
    stop = watchConnection(client.realtime, (state) => {
      connectionState.value = state
    })
  })
  onUnmounted(() => stop?.())

  return { connectionState, isConnected: computed(() => connectionState.value === "connected") }
}
