import { useEffect, useRef } from "react"
import type { RealtimeEvent, RealtimePayload } from "@supatype/client"
import { useSupatype } from "./context.js"

export type SubscriptionStatus =
  | "SUBSCRIBED"
  | "TIMED_OUT"
  | "CLOSED"
  | "CHANNEL_ERROR"
  /** Placeholder status while real-time WebSocket support is not yet active (Phase 8). */
  | "STUB"

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
  /** Current subscription status. "STUB" until Phase 8 real-time is active. */
  status: SubscriptionStatus
}

/**
 * Subscribe to real-time row changes on a table.
 *
 * **Note:** This is a placeholder until Phase 8 (real-time). The `callback`
 * will not fire and `status` will always be `"STUB"`.
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
      .subscribe()

    return () => {
      channel.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channelName, opts.event, opts.schema, opts.table, opts.filter])

  // Phase 8 will return the real WebSocket status. Until then, always STUB.
  return { status: "STUB" }
}
