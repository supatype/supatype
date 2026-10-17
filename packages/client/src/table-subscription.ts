import type { ChannelStatus, RealtimeClient, RealtimeEvent, RealtimePayload } from "./realtime.js"
import type { SupatypeError } from "./types.js"
import { isJsonObject } from "./json.js"

/**
 * A table's live rows, for `from(table).subscribe()` and for the Vue, Svelte and Solid bindings.
 *
 * Each binding carried its own copy of the channel wiring, the status mapping and the row merge,
 * beside the client's own wiring for `from(table).subscribe()`. The copies drifted the way copies
 * do: none of the three bindings mapped SUBSCRIBING, so while a sign-in swapped the socket all
 * three read "connected" with no join anywhere, and all three still shared one `public:table`
 * channel that the client's own subscribe had long since stopped sharing. One copy here means
 * each binding is only the adapter between this and its framework's state.
 */

/** What a binding shows for a subscription's connection. */
export type SubscriptionState = "connecting" | "connected" | "disconnected" | "error"

/** A binding's status and error, as one channel status implies them. */
export interface SubscriptionView {
  status: SubscriptionState
  error: SupatypeError | null
}

export interface TableWatchOptions {
  event?: RealtimeEvent | undefined
  filter?: string | undefined
}

export interface TableSubscribeOptions extends TableWatchOptions {
  schema?: string | undefined
}

export interface TableWatchHandlers<TRow> {
  /** The rows seen so far, after each change. */
  rows(rows: TRow[]): void
  /** The connection, after each status the channel reports. */
  status(view: SubscriptionView): void
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

/**
 * The status and error a binding shows for a channel status.
 *
 * A refused join and a reconnect that gave up are both errors: neither is going to deliver
 * anything without the caller doing something about it.
 */
export function subscriptionViewOf(status: ChannelStatus): SubscriptionView {
  switch (status) {
    case "SUBSCRIBING":
      return { status: "connecting", error: null }
    case "SUBSCRIBED":
      return { status: "connected", error: null }
    case "CLOSED":
      return { status: "disconnected", error: null }
    case "CHANNEL_ERROR":
      return { status: "error", error: { message: "Subscription error" } }
    case "TIMED_OUT":
      return { status: "error", error: { message: "Realtime connection timed out" } }
  }
}

function rowId(row: unknown): unknown {
  return isJsonObject(row) ? row["id"] : undefined
}

/**
 * The rows after one change, matched on `id`.
 *
 * An insert or update always carries the new row; one without it (which the service does not send)
 * leaves the rows as they were rather than putting a null among them.
 */
export function applyRowChange<TRow>(rows: TRow[] | null, payload: RealtimePayload<TRow>): TRow[] {
  const current = rows ?? []
  const next = payload.new
  switch (payload.eventType) {
    case "INSERT":
      return next === null ? current : [...current, next]
    case "UPDATE":
      return next === null ? current : current.map((row) => (rowId(row) === rowId(next) ? next : row))
    case "DELETE":
      return current.filter((row) => rowId(row) !== rowId(payload.old))
    default:
      return current
  }
}

/**
 * Subscribe to changes on a `public` table, and return the unsubscribe.
 *
 * The handlers are told the rows and the connection status; the binding decides where they live.
 * The status is watched on the channel `subscribeToTable` already joined, which is what its
 * channel's `subscribe(cb)` is for.
 */
export function watchTable<TRow>(
  realtime: RealtimeClient,
  table: string,
  options: TableWatchOptions | undefined,
  handlers: TableWatchHandlers<TRow>,
): () => void {
  let rows: TRow[] | null = null
  const subscription = subscribeToTable<TRow>(
    realtime,
    table,
    (payload) => {
      rows = applyRowChange(rows, payload)
      handlers.rows(rows)
    },
    options,
  )
  subscription.channel.subscribe((status) => handlers.status(subscriptionViewOf(status)))
  return subscription.unsubscribe
}
