import { derived, writable, type Readable } from "svelte/store"
import { onDestroy } from "svelte"
import type { AugmentedDatabase, AnyDatabase, RealtimeConnectionState } from "@supatype/client"
import { watchConnection } from "@supatype/client/bindings"
import { getSupatypeClient } from "./context.js"

export interface RealtimeConnectionStore {
  /** "connecting" covers the first connect, a reconnect after a drop, and the sign-in swap. */
  connectionState: Readable<RealtimeConnectionState>
  /** True while the realtime socket is open. A channel may still be waiting on its join. */
  isConnected: Readable<boolean>
}

/**
 * The realtime socket's own state, which no channel status reports: a drop and a first connect both
 * read "connecting" on a channel. Reported by `watchConnection`, shared with Vue and Solid.
 */
export function createRealtimeConnection<TDatabase extends AnyDatabase = AugmentedDatabase>(): RealtimeConnectionStore {
  const client = getSupatypeClient<TDatabase>()
  const state = writable<RealtimeConnectionState>(client.realtime.connectionState)

  onDestroy(watchConnection(client.realtime, (next) => state.set(next)))

  return {
    connectionState: { subscribe: state.subscribe },
    isConnected: derived(state, ($state) => $state === "connected"),
  }
}
