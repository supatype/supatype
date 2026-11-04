import type { AnyClient } from "./index.js"
import type { DraftUpdateOptions, QueryResult, SupatypeError } from "./types.js"
import { isRowsOf } from "./caller-types.js"

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

export type MutationRows = Record<string, unknown> | Record<string, unknown>[]

/** The rows to return: `true` for every column, or the columns as `.select()` takes them. */
export type MutationSelect = true | string

/** How a binding's mutation is made beyond its operation and data. */
export interface MutationRequest extends DraftUpdateOptions {
  /** Equality filters for an update or delete. */
  filter?: Record<string, unknown> | undefined
  /**
   * Return the written rows. Without it a write returns none, as the client's own writes do:
   * returning a row needs the right to read it as well as to write it.
   */
  select?: MutationSelect | undefined
}

export interface MutationOutcome<TRow> {
  data: TRow[] | null
  error: SupatypeError | null
  count: number | null
}

type PendingMutation = PromiseLike<QueryResult<unknown>>
type SelectableMutation = PendingMutation & { select(columns?: string | undefined): PendingMutation }

/** The write, asking for its rows back only when `select` says to. */
function returning(write: SelectableMutation, select: MutationSelect | undefined): PendingMutation {
  if (select === undefined) return write
  return write.select(select === true ? undefined : select)
}

/**
 * The request `operation` makes, or why it cannot make one: an insert or upsert with nothing to
 * write, or an update that is not one object of changes, used to go out and come back as the
 * server's error.
 *
 * Through the untyped client: the generated Insert and Update types do not survive a table name
 * known only at run time, so `data` goes out as the caller wrote it and PostgREST is what checks it.
 */
function mutationRequest(
  tableClient: ReturnType<AnyClient["from"]>,
  operation: MutationOperation,
  data: MutationRows | undefined,
  request: MutationRequest,
): PendingMutation | string {
  const filter = request.filter ?? {}
  if (operation === "delete") return returning(tableClient.delete().match(filter), request.select)
  if (operation === "update") {
    if (data === undefined || Array.isArray(data)) return "update needs one object of the changes to make"
    return returning(tableClient.update(data, request).match(filter), request.select)
  }
  if (data === undefined) return `${operation} needs the row or rows to write`
  return returning(operation === "insert" ? tableClient.insert(data) : tableClient.upsert(data), request.select)
}

/**
 * Run one mutation against `table`. The outcome holds rows only when `request.select` asked for
 * them, typed as the caller's row.
 *
 * `request.publish` is an update's: on a model that keeps drafts, it publishes the drafts it saves
 * in the same call.
 */
export async function runMutation<TRow>(
  client: AnyClient,
  table: string,
  operation: MutationOperation,
  data: MutationRows | undefined,
  request: MutationRequest = {},
): Promise<MutationOutcome<TRow>> {
  const pending = mutationRequest(client.from(table), operation, data, request)
  if (typeof pending === "string") return { data: null, error: { message: pending }, count: null }
  const result = await pending
  return { data: isRowsOf<TRow>(result.data) ? result.data : null, error: result.error, count: result.count }
}
