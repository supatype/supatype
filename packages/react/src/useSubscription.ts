import { useEffect, useRef, useState } from "react"
import type { RealtimeEvent, RealtimePayload, ChannelStatus } from "@supatype/client"
import { useSupatype } from "./context.js"

export type SubscriptionStatus = ChannelStatus

export interface UseSubscriptionOptions<TRow> {
  /** Postgres event to listen for. Defaults to "*" (all events). */
  event?: RealtimeEvent | undefined
  /** Table to listen on. Defaults to the channel name. */
  table?: string | undefined
  /** PostgREST filter expression (e.g. "id=eq.1"). */
  filter?: string | undefined
  /** Schema to listen on. Defaults to "public". */
  schema?: string | undefined
  /** Called on every change event matching the subscription. */
  callback: (payload: RealtimePayload<TRow>) => void
}

export interface UseSubscriptionResult {
  /** Current subscription status. */
  status: SubscriptionStatus
}

/**
 * Subscribe to real-time row changes on a table.
 *
 * @example
 * ```tsx
 * useSubscription<Post>('posts-channel', {
 *   event: 'INSERT',
 *   table: 'posts',
 *   callback: (payload) => console.log('New post:', payload.new),
 * })
 * ```
 */
export function useSubscription<TRow = Record<string, unknown>>(
  channelName: string,
  opts: UseSubscriptionOptions<TRow>,
): UseSubscriptionResult {
  const client = useSupatype()
  const [status, setStatus] = useState<SubscriptionStatus>("SUBSCRIBING")

  // Stable ref so the effect doesn't re-run when the callback reference changes
  const callbackRef = useRef(opts.callback)
  callbackRef.current = opts.callback

  useEffect(() => {
    const channel = client.realtime
      .channel<TRow>(channelName)
      .on(
        "postgres_changes",
        {
          event: opts.event ?? "*",
          ...(opts.schema !== undefined && { schema: opts.schema }),
          ...(opts.table !== undefined && { table: opts.table }),
          ...(opts.filter !== undefined && { filter: opts.filter }),
        },
        (payload) => callbackRef.current(payload),
      )
      .subscribe((s) => setStatus(s))

    return () => {
      channel.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channelName, opts.event, opts.schema, opts.table, opts.filter])

  return { status }
}
