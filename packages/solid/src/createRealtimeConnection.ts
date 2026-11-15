import { createSignal, onMount, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyDatabase, RealtimeConnectionState } from "@supatype/client"
import { watchConnection } from "@supatype/client/bindings"
import { useSupatype } from "./context.js"

export interface RealtimeConnectionResult {
  /** "connecting" covers the first connect, a reconnect after a drop, and the sign-in swap. */
  connectionState: Accessor<RealtimeConnectionState>
  /** True while the realtime socket is open. A channel may still be waiting on its join. */
  isConnected: Accessor<boolean>
}

/**
 * The realtime socket's own state, which no channel status reports: a drop and a first connect both
 * read "connecting" on a channel. Reported by `watchConnection`, shared with Vue and Svelte.
 */
export function createRealtimeConnection<TDatabase extends AnyDatabase = AugmentedDatabase>(): RealtimeConnectionResult {
  const client = useSupatype<TDatabase>()
  const [connectionState, setState] = createSignal<RealtimeConnectionState>(client.realtime.connectionState)

  onMount(() => {
    onCleanup(watchConnection(client.realtime, setState))
  })

  return { connectionState, isConnected: () => connectionState() === "connected" }
}
