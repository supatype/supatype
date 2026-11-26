"use client"

import { useSyncExternalStore } from "react"
import type { RealtimeConnectionState } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface UseRealtimeConnectionResult {
  /** True while the realtime socket is open. A channel may still be waiting on its join. */
  isConnected: boolean
  /** "connecting" covers the first connect, a reconnect after a drop, and the sign-in swap. */
  connectionState: RealtimeConnectionState
}

/**
 * The realtime socket's own state, which no channel status reports: a drop and a first connect both
 * read SUBSCRIBING on a channel.
 */
export function useRealtimeConnection(): UseRealtimeConnectionResult {
  const { realtime } = useSupatype()
  const connectionState = useSyncExternalStore(
    (notify) => realtime.onConnectionChange(notify),
    () => realtime.connectionState,
    (): RealtimeConnectionState => "disconnected",
  )
  return { isConnected: connectionState === "connected", connectionState }
}
