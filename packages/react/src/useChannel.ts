"use client"

import { useEffect, useState, type DependencyList } from "react"
import type { ChannelActionRefusal, ChannelOptions, ChannelStatus, ChannelSubscription } from "@supatype/client"
import { useSupatype } from "./context.js"
import { useRealtimeConnection, type UseRealtimeConnectionResult } from "./useRealtimeConnection.js"

export interface UseChannelResult extends UseRealtimeConnectionResult {
  /** This channel's join status. */
  status: ChannelStatus
  /** Why the server refused the join, while the status is CHANNEL_ERROR; null otherwise. */
  error: Error | null
  /**
   * The latest broadcast, presence track or payload the server refused on this channel, or null.
   * The channel stays joined (`status` does not change); this is how the app learns a send went
   * nowhere. Cleared when the channel changes.
   */
  refusal: ChannelActionRefusal | null
}

interface ChannelState {
  status: ChannelStatus
  error: Error | null
  refusal: ChannelActionRefusal | null
}

const JOINING: ChannelState = { status: "SUBSCRIBING", error: null, refusal: null }

/**
 * Join one channel and register whatever listeners `setup` adds to it: row changes, presence and
 * broadcast together, which `useSubscription` (one row listener) cannot do.
 *
 * `setup` receives the channel before it is subscribed and must only add listeners; the hook
 * subscribes, and unsubscribes when the component unmounts or `name` or `deps` change. Like
 * `useEffect`, `setup` runs again only when `deps` change, so list whatever it reads.
 *
 * `options.private` asks for a private channel (a schema `Channel` declaration guards it): see
 * `ChannelOptions`. A refused or withdrawn join shows as `error`, a `RealtimeChannelError` whose `reason`
 * says why.
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
  options: ChannelOptions = {},
): UseChannelResult {
  const { realtime } = useSupatype()
  const [state, setState] = useState<ChannelState>(JOINING)
  const connection = useRealtimeConnection()
  const isPrivate = options.private === true

  useEffect(() => {
    setState(JOINING)
    const channel = realtime.channel<TRow>(name, { private: isPrivate })
    setup(channel)
    channel.onRefused((refusal) => setState((prev) => ({ ...prev, refusal })))
    channel.subscribe((status, err) => {
      const error = err ?? null
      setState((prev) => (prev.status === status && prev.error === error ? prev : { ...prev, status, error }))
    })
    return () => {
      channel.unsubscribe()
    }
    // `setup` is read through `deps`, as with useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtime, name, isPrivate, ...deps])

  return { ...state, ...connection }
}
