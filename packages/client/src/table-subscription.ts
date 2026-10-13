import type { RealtimeClient, RealtimeEvent, RealtimePayload } from "./realtime.js"

/**
 * One table's subscription: the channel wiring `from(table).subscribe()` uses.
 */

export interface TableSubscribeOptions {
  event?: RealtimeEvent | undefined
  filter?: string | undefined
  schema?: string | undefined
}

export interface TableSubscription {
  unsubscribe: () => void
  channel: ReturnType<RealtimeClient["channel"]>
}

/**
 * Makes each table subscription's channel name unique.
 *
 * Module-wide rather than per client because it only has to be unique, and a name never seen by
 * one client cannot collide on another.
 */
let tableSubscriptionCount = 0

/**
 * Subscribe to postgres_changes on one table, and join.
 *
 * Each call gets a channel of its own, named `schema:table:n`. The server keys a subscription by
 * channel, so two calls sharing `schema:table` shared one filter and one event, and the first to
 * unsubscribe removed the channel out from under the second. The name still reads as
 * `schema:table` to anything that splits it, which is what a server predating `table` in the
 * subscribe frame falls back to.
 */
export function subscribeToTable<TRow>(
  realtime: RealtimeClient,
  table: string,
  callback: (payload: RealtimePayload<TRow>) => void,
  opts?: TableSubscribeOptions | undefined,
): TableSubscription {
  const schema = opts?.schema ?? "public"
  tableSubscriptionCount += 1
  const channel = realtime
    .channel<TRow>(`${schema}:${table}:${tableSubscriptionCount}`)
    .on(
      "postgres_changes",
      {
        event: opts?.event ?? "*",
        schema,
        table,
        ...(opts?.filter !== undefined && { filter: opts.filter }),
      },
      callback,
    )
    // `on()` only records the listener. Without this nothing opened a socket or sent the join,
    // and the callback waited forever unless something else on the client had joined already.
    .subscribe()
  return { channel, unsubscribe: () => channel.unsubscribe() }
}
