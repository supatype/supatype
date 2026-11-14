import type { ChannelStatus, RealtimeClient, RealtimeEvent, RealtimePayload } from "./realtime.js"
import { SupatypeError } from "./errors.js"
import { isJsonObject } from "./json.js"
import { isRowsOf } from "./caller-types.js"
import { reportThrown } from "./thrown-error.js"
import type { AnyClient } from "./index.js"

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

/** Which changes a table subscription hears. */
interface TableChangeOptions {
  event?: RealtimeEvent | undefined
  filter?: string | undefined
}

export interface TableWatchOptions extends TableChangeOptions {
  /**
   * The column or columns that identify a row, which an upsert or a delete matches on. Default
   * "id". Name the primary key when it is not `id`.
   */
  key?: string | readonly string[] | undefined
}

export interface TableSubscribeOptions extends TableChangeOptions {
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
 * anything without the caller doing something about it. A refusal shows the server's reason when
 * the channel passed one (`err`), such as which table does not exist; "Subscription error" only
 * when it did not.
 */
export function subscriptionViewOf(status: ChannelStatus, err?: Error | undefined): SubscriptionView {
  switch (status) {
    case "SUBSCRIBING":
      return { status: "connecting", error: null }
    case "SUBSCRIBED":
      return { status: "connected", error: null }
    case "CLOSED":
      return { status: "disconnected", error: null }
    case "CHANNEL_ERROR":
      return { status: "error", error: new SupatypeError({ message: err?.message ?? "Subscription error" }) }
    case "TIMED_OUT":
      return { status: "error", error: new SupatypeError({ message: "Realtime connection timed out" }) }
  }
}

const DEFAULT_KEY: readonly string[] = ["id"]

function keyColumnsOf(key: string | readonly string[] | undefined): readonly string[] {
  if (key === undefined) return DEFAULT_KEY
  return typeof key === "string" ? [key] : key
}

/** The row's key as one comparable string, or undefined when a key column is missing or null. */
function keyOf(row: unknown, key: readonly string[]): string | undefined {
  if (!isJsonObject(row)) return undefined
  const parts = key.map((column) => row[column])
  return parts.some((part) => part === undefined || part === null) ? undefined : parts.map(String).join("\u0000")
}

/** `rows` with `next` in place of the row sharing its key, or added when none does. */
function upserted<TRow>(rows: TRow[], next: TRow, key: readonly string[]): TRow[] {
  const wanted = keyOf(next, key)
  const at = wanted === undefined ? -1 : rows.findIndex((row) => keyOf(row, key) === wanted)
  if (at < 0) return [...rows, next]
  return rows.map((row, i) => (i === at ? next : row))
}

/**
 * The rows after one change, matched on `key` (the `id` column unless the subscription names others).
 *
 * An INSERT or UPDATE is an upsert: a row seen twice is listed once, and an update to a row not seen
 * yet adds it. A DELETE removes by key, and one for a key not held leaves the rows as they were.
 * An insert or update without its row (which the service does not send), or one whose row has no
 * key to match, leaves the rows as they were rather than putting a null or a duplicate among them.
 */
export function applyRowChange<TRow>(
  rows: TRow[] | null,
  payload: RealtimePayload<TRow>,
  key: readonly string[] = DEFAULT_KEY,
): TRow[] {
  const current = rows ?? []
  switch (payload.eventType) {
    case "INSERT":
    case "UPDATE":
      return payload.new === null || keyOf(payload.new, key) === undefined ? current : upserted(current, payload.new, key)
    case "DELETE": {
      const gone = keyOf(payload.old, key)
      return gone === undefined ? current : current.filter((row) => keyOf(row, key) !== gone)
    }
    default:
      return current
  }
}

// ─── Reading the table ───────────────────────────────────────────────────────

/** A query the subscription's filter conditions can be applied to: the client's `QueryBuilder`. */
interface Narrowable<Q> {
  eq(column: string, value: unknown): Q
  neq(column: string, value: unknown): Q
  gt(column: string, value: unknown): Q
  gte(column: string, value: unknown): Q
  lt(column: string, value: unknown): Q
  lte(column: string, value: unknown): Q
}

const CONDITION = /^([^=]+)=([a-z]+)\.(.*)$/s
const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const
type Operator = (typeof OPERATORS)[number]

function isOperator(text: string | undefined): text is Operator {
  return OPERATORS.some((known) => known === text)
}

/**
 * `query` narrowed by the conditions of a subscription's `filter`, so the rows read are the rows
 * the subscription hears about. A condition the service ignores (an operator it does not know) is
 * ignored here too.
 */
function withConditions<Q extends Narrowable<Q>>(query: Q, filter: string | undefined): Q {
  let narrowed = query
  for (const text of (filter ?? "").split(",")) {
    const match = CONDITION.exec(text.trim())
    const op = match?.[2]
    if (match === null || !isOperator(op)) continue
    narrowed = narrowed[op](match[1] ?? "", match[3] ?? "")
  }
  return narrowed
}

type TableRead<TRow> = { rows: TRow[]; error: null } | { rows: null; error: SupatypeError }

async function readTable<TRow>(client: AnyClient, table: string, filter: string | undefined): Promise<TableRead<TRow>> {
  try {
    const result = await withConditions(client.from(table).select("*"), filter)
    if (result.error !== null) return { rows: null, error: result.error }
    return isRowsOf<TRow>(result.data) ? { rows: result.data, error: null } : { rows: [], error: null }
  } catch (e) {
    return { rows: null, error: reportThrown(`watchTable("${table}")`, e) }
  }
}

// ─── A watched table ─────────────────────────────────────────────────────────

/**
 * One subscription's rows.
 *
 * Seeded by a read of the table each time the channel's join is acknowledged: the first join, and
 * every join after a drop or a sign-in swap. Reading after the join, not before it, leaves no gap:
 * a change committed before the join is in the read, and one committed after it is delivered. The
 * read is not the same as the changes a drop missed, so each re-join replaces the rows with a fresh
 * read rather than trying to patch them.
 *
 * Changes that arrive while a read is in flight are replayed over it, in order, so the read
 * cannot undo them. Only the newest read counts.
 */
class WatchedRows<TRow> {
  private rows: TRow[] | null = null
  private replay: RealtimePayload<TRow>[] | null = null
  private reads = 0
  private joined = false
  private view: SubscriptionView = { status: "connecting", error: null }
  private readFailed = false
  private stopped = false

  constructor(
    private readonly client: AnyClient,
    private readonly table: string,
    private readonly options: TableWatchOptions | undefined,
    private readonly handlers: TableWatchHandlers<TRow>,
  ) {}

  change(payload: RealtimePayload<TRow>): void {
    this.replay?.push(payload)
    this.show(applyRowChange(this.rows, payload, keyColumnsOf(this.options?.key)))
  }

  status(view: SubscriptionView): void {
    const rejoined = view.status === "connected" && !this.joined
    this.joined = view.status === "connected"
    this.view = view
    this.handlers.status(view)
    if (rejoined) void this.seed()
  }

  stop(): void {
    this.stopped = true
  }

  private show(rows: TRow[]): void {
    if (this.stopped) return
    this.rows = rows
    this.handlers.rows(rows)
  }

  private async seed(): Promise<void> {
    const read = ++this.reads
    this.replay ??= []
    const answer = await readTable<TRow>(this.client, this.table, this.options?.filter)
    if (read !== this.reads || this.stopped) return
    const missed = this.replay
    this.replay = null
    this.reportRead(answer.error)
    if (answer.rows === null) return
    const key = keyColumnsOf(this.options?.key)
    this.show(missed.reduce((rows, payload) => applyRowChange(rows, payload, key), answer.rows))
  }

  /** A failed read is the subscription's error until a read succeeds; the channel's status stands. */
  private reportRead(error: SupatypeError | null): void {
    if (error !== null) this.handlers.status({ ...this.view, error })
    else if (this.readFailed) this.handlers.status(this.view)
    this.readFailed = error !== null
  }
}

/**
 * Subscribe to changes on a `public` table, and return the unsubscribe.
 *
 * The handlers are told the rows and the connection status; the binding decides where they live.
 * The rows are the table's own: read when the subscription joins and again after each re-join, and
 * kept current by upserting each change by key. `options.filter` narrows both the read and the
 * changes. The status is watched on the channel `subscribeToTable` already joined, which is what
 * its channel's `subscribe(cb)` is for.
 */
export function watchTable<TRow>(
  client: AnyClient,
  table: string,
  options: TableWatchOptions | undefined,
  handlers: TableWatchHandlers<TRow>,
): () => void {
  const watched = new WatchedRows<TRow>(client, table, options, handlers)
  const subscription = subscribeToTable<TRow>(client.realtime, table, (payload) => watched.change(payload), options)
  subscription.channel.subscribe((status, err) => watched.status(subscriptionViewOf(status, err)))
  return () => {
    watched.stop()
    subscription.unsubscribe()
  }
}
