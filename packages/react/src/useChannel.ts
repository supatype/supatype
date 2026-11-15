"use client"

import { useEffect, useState, type DependencyList } from "react"
import type { ChannelStatus, ChannelSubscription } from "@supatype/client"
import { useSupatype } from "./context.js"
import { useRealtimeConnection, type UseRealtimeConnectionResult } from "./useRealtimeConnection.js"

export interface UseChannelResult extends UseRealtimeConnectionResult {
  /** This channel's join status. */
  status: ChannelStatus
  /** Why the server refused the join, while the status is CHANNEL_ERROR; null otherwise. */
  error: Error | null
}

interface ChannelState {
  status: ChannelStatus
  error: Error | null
}

const JOINING: ChannelState = { status: "SUBSCRIBING", error: null }

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `useSubscription` (one row listener) cannot do.
 *
 * `setup` receives the channel before it is subscribed and must only add listeners; the hook
 * subscribes, and unsubscribes when the component unmounts or `name` or `deps` change. Like
 * `useEffect`, `setup` runs again only when `deps` change, so list whatever it reads.
 *
 * @example
 * ```tsx
 * const { status, isConnected } = useChannel<Bid>("auction:42", (channel) => {
 *   channel.on("postgres_changes", { event: "INSERT", table: "bid" }, (p) => addBid(p.new))
 *   channel.onBroadcast("outbid", (p) => notify(p))
 * }, [addBid, notify])
 * ```
 */
export function useChannel<TRow = Record<string, unknown>>(
  name: string,
  setup: (channel: ChannelSubscription<TRow>) => void,
  deps: DependencyList = [],
): UseChannelResult {
  const { realtime } = useSupatype()
  const [state, setState] = useState<ChannelState>(JOINING)
  const connection = useRealtimeConnection()

  useEffect(() => {
    setState(JOINING)
    const channel = realtime.channel<TRow>(name)
    setup(channel)
    channel.subscribe((status, err) => {
      const error = err ?? null
      setState((prev) => (prev.status === status && prev.error === error ? prev : { status, error }))
    })
    return () => {
      channel.unsubscribe()
    }
    // `setup` is read through `deps`, as with useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtime, name, ...deps])

  return { ...state, ...connection }
}
