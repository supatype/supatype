import type { AnyClient } from "./index.js"
import type { MutationBuilder } from "./query.js"
import type { DraftUpdateOptions, SupatypeError } from "./types.js"
import { isRowsOf } from "./caller-types.js"

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

export type MutationRows = Record<string, unknown> | Record<string, unknown>[]

export interface MutationOutcome<TRow> {
  data: TRow[] | null
  error: SupatypeError | null
  count: number | null
}

type PendingMutation = MutationBuilder<Record<string, unknown>>

function withFilter(pending: PendingMutation, filter: Record<string, unknown>): PendingMutation {
  let filtered = pending
  for (const [col, val] of Object.entries(filter)) filtered = filtered.eq(col, val)
  return filtered
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
  filter: Record<string, unknown>,
  options: DraftUpdateOptions,
): PendingMutation | string {
  if (operation === "delete") return withFilter(tableClient.delete(), filter)
  if (operation === "update") {
    if (data === undefined || Array.isArray(data)) return "update needs one object of the changes to make"
    return withFilter(tableClient.update(data, options), filter)
  }
  if (data === undefined) return `${operation} needs the row or rows to write`
  return operation === "insert" ? tableClient.insert(data) : tableClient.upsert(data)
}

/**
 * Run one mutation against `table`, with the rows that come back as the caller's row type.
 *
 * `options` is an update's: on a model that keeps drafts, `{ publish: true }` publishes the drafts
 * it saves in the same call.
 */
export async function runMutation<TRow>(
  client: AnyClient,
  table: string,
  operation: MutationOperation,
  data: MutationRows | undefined,
  filter: Record<string, unknown> = {},
  options: DraftUpdateOptions = {},
): Promise<MutationOutcome<TRow>> {
  const pending = mutationRequest(client.from(table), operation, data, filter, options)
  if (typeof pending === "string") return { data: null, error: { message: pending }, count: null }
  const result = await pending
  return { data: isRowsOf<TRow>(result.data) ? result.data : null, error: result.error, count: result.count }
}
