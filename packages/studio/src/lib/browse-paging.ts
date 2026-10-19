/**
 * How many rows the data browser pages over.
 *
 * It took the planner's estimate (`reltuples`) as the table's size, so a table of 30 rows that
 * Postgres last sampled at 18 said "Page 1 of 1 (18 rows)" at 25 per page and rows 26 to 30 could
 * not be reached; with a filter it kept whatever total it had before. The count now comes from the
 * server with the page itself:
 *
 * - Exact for a table up to `EXACT_COUNT_LIMIT` rows by the estimate, where counting is cheap and
 *   the figure shown should be right.
 * - Estimated beyond that, where an exact count reads the whole table on every page. An estimate
 *   can be low, so a full page always offers the next one: no row is ever out of reach, only the
 *   page count is approximate, and the view says so.
 */

/** Up to this many rows by the planner's estimate, a page asks for an exact count. */
export const EXACT_COUNT_LIMIT = 100_000

export type CountMode = "exact" | "estimated"

/** How to count a table the planner puts at `estimate` rows (negative: never analysed). */
export function countModeFor(estimate: number): CountMode {
  return estimate > EXACT_COUNT_LIMIT ? "estimated" : "exact"
}

/** A page as it came back: the server's count, how it was counted, where it starts and its rows. */
export interface BrowsePage {
  count: number | null
  mode: CountMode
  from: number
  rows: number
}

/**
 * The rows to page over. An exact count is the answer. Otherwise a short page is the last one, so
 * it settles the total, and a full page means at least one more row may follow.
 */
export function browseTotal(page: BrowsePage, pageSize: number): number {
  if (page.count !== null && page.mode === "exact") return page.count
  if (page.rows < pageSize) return page.from + page.rows
  return Math.max(page.count ?? 0, page.from + page.rows + 1)
}

/** The total as the pager says it: approximate when it is an estimate. */
export function totalLabel(total: number, mode: CountMode): string {
  return mode === "estimated" ? `about ${total} rows` : `${total} rows`
}
