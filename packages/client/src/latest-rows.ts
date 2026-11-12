import type { AnyClient } from "./index.js"
import type { SupatypeError } from "./types.js"
import { isRowsOf } from "./caller-types.js"
import { reportThrown } from "./thrown-error.js"

/** The read the Vue, Svelte and Solid queries make: columns, equality filters, order and a page. */
export interface RowsReadOptions {
  columns?: string | undefined
  filter?: Record<string, unknown> | undefined
  order?: { column: string; ascending?: boolean | undefined } | undefined
  limit?: number | undefined
  offset?: number | undefined
}

/** Where a binding shows its reads: one started, and the newest one's answer. */
export interface RowsView<TRow> {
  started(): void
  settled(data: TRow[] | null, error: SupatypeError | null): void
}

/**
 * A binding's reads of one table, where only the newest may change what it shows.
 *
 * A refetch while a read is in flight puts two reads on the wire, and the older can land last;
 * its answer, a returned error or a throw, is dropped rather than replacing the newer one's. A
 * read that throws (a client with no API address, say) ends like one that was refused, and is
 * reported once with `console.error` even when a newer read has replaced it. `where` names the
 * binding in that report.
 */
export function latestRowsReader<TRow>(
  client: AnyClient,
  table: string,
  where: string,
  view: RowsView<TRow>,
): (options: RowsReadOptions | undefined) => Promise<void> {
  let latest = 0
  return async (options) => {
    const request = ++latest
    view.started()
    const answer = await answerOf<TRow>(client, table, where, options)
    if (request === latest) view.settled(answer.data, answer.error)
  }
}

async function answerOf<TRow>(
  client: AnyClient,
  table: string,
  where: string,
  options: RowsReadOptions | undefined,
): Promise<{ data: TRow[] | null; error: SupatypeError | null }> {
  try {
    const result = await readRows(client, table, options)
    return { data: isRowsOf<TRow>(result.data) ? result.data : null, error: result.error }
  } catch (e) {
    return { data: null, error: reportThrown(where, e) }
  }
}

/**
 * The read `options` describe. Through the untyped client: the generated row types do not survive
 * a table name known only at run time, so the binding types the rows as `TRow` once they arrive.
 */
function readRows(client: AnyClient, table: string, options: RowsReadOptions | undefined) {
  let query = client.from(table).select(options?.columns)
  for (const [col, val] of Object.entries(options?.filter ?? {})) {
    query = query.eq(col, val)
  }
  if (options?.order !== undefined) {
    query = query.order(options.order.column, { ascending: options.order.ascending ?? true })
  }
  return withPage(query, options)
}

/** How many rows a binding's query reads from an `offset` given with no `limit`. */
const DEFAULT_PAGE_SIZE = 100

/** A query a page can be applied to: the client's `QueryBuilder`, whatever its row type. */
interface Pageable<Q> {
  limit(count: number): Q
  range(from: number, to: number): Q
}

/**
 * `query` limited to the page `limit` and `offset` describe, for every binding's query. An offset
 * with no limit reads `DEFAULT_PAGE_SIZE` rows: React's `useQuery` used to drop the offset there
 * while the Vue, Svelte and Solid queries read 100, so the same options read different rows.
 */
export function withPage<Q extends Pageable<Q>>(
  query: Q,
  page: { limit?: number | undefined; offset?: number | undefined } | undefined,
): Q {
  const limited = page?.limit !== undefined ? query.limit(page.limit) : query
  if (page?.offset === undefined) return limited
  return limited.range(page.offset, page.offset + (page.limit ?? DEFAULT_PAGE_SIZE) - 1)
}
