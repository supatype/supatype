/**
 * Slow query log component.
 *
 * Displays slow queries captured by Postgres `pg_stat_statements`.
 * The host app provides a `onRunQuery` callback to execute SQL.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react"
import { Button, DisclosureButton, LoadingRows, TableCard, Td, TextLink, Th, tableRowClass } from "../ui.js"
import { EmptyState } from "../EmptyState.js"
import { ErrorBanner } from "../ErrorBanner.js"

// -- Types -------------------------------------------------------------------

interface SlowQuery {
  queryId: string
  query: string
  calls: number
  totalTimeMs: number
  meanTimeMs: number
  maxTimeMs: number
  rows: number
  /** Percentage of total database time consumed by this query. */
  timePct: number
}

export interface SlowQueryLogProps {
  /** Executes a SQL query and returns the rows. */
  onRunQuery: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>
  /** Minimum query duration in milliseconds to display. Defaults to 1000. */
  minDurationMs?: number
  /** Maximum number of queries to display. Defaults to 50. */
  limit?: number
  /** Auto-refresh interval in seconds. Set to 0 to disable. Defaults to 30. */
  refreshIntervalSeconds?: number
}

type SortField = "totalTimeMs" | "meanTimeMs" | "maxTimeMs" | "calls" | "rows"
type SortDirection = "asc" | "desc"

// -- Helpers -----------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function truncateQuery(query: string, maxLength = 200): string {
  const normalized = query.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...`
}

/** The pg_stat_statements column each sortable field ranks by. */
const ORDER_COLUMN: Record<SortField, string> = {
  totalTimeMs: "total_exec_time",
  meanTimeMs: "mean_exec_time",
  maxTimeMs: "max_exec_time",
  calls: "calls",
  rows: "rows",
}

/**
 * The top `limit` statements by the sorted column, ranked by the database. Ranking by total time
 * and re-sorting those in the browser left out a query with a high mean but a low total.
 */
function buildSlowQuerySQL(minDurationMs: number, limit: number, order: { field: SortField; direction: SortDirection }): string {
  return `
    SELECT
      queryid::text AS query_id,
      query,
      calls,
      round(total_exec_time::numeric, 2) AS total_time_ms,
      round(mean_exec_time::numeric, 2) AS mean_time_ms,
      round(max_exec_time::numeric, 2) AS max_time_ms,
      rows,
      round((total_exec_time / NULLIF(sum(total_exec_time) OVER (), 0) * 100)::numeric, 2) AS time_pct
    FROM pg_stat_statements
    WHERE mean_exec_time >= ${minDurationMs}
      AND query NOT LIKE '%pg_stat_statements%'
    ORDER BY ${ORDER_COLUMN[order.field]} ${order.direction === "desc" ? "DESC" : "ASC"}
    LIMIT ${limit}
  `.trim()
}

// -- Component ---------------------------------------------------------------

export function SlowQueryLog({
  onRunQuery,
  minDurationMs = 1000,
  limit = 50,
  refreshIntervalSeconds = 30,
}: SlowQueryLogProps) {
  const [queries, setQueries] = useState<SlowQuery[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>("totalTimeMs")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")
  const [expandedQueryId, setExpandedQueryId] = useState<string | null>(null)

  const fetchSlowQueries = useCallback(async () => {
    try {
      const sql = buildSlowQuerySQL(minDurationMs, limit, { field: sortField, direction: sortDirection })
      const data = await onRunQuery(sql)

      setQueries(
        data.rows.map((row) => ({
          queryId: String(row.query_id),
          query: String(row.query),
          calls: Number(row.calls),
          totalTimeMs: Number(row.total_time_ms),
          meanTimeMs: Number(row.mean_time_ms),
          maxTimeMs: Number(row.max_time_ms),
          rows: Number(row.rows),
          timePct: Number(row.time_pct),
        })),
      )
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch slow queries")
    } finally {
      setLoading(false)
    }
  }, [onRunQuery, minDurationMs, limit, sortField, sortDirection])

  useEffect(() => {
    void fetchSlowQueries()

    if (refreshIntervalSeconds > 0) {
      const interval = setInterval(() => void fetchSlowQueries(), refreshIntervalSeconds * 1000)
      return () => clearInterval(interval)
    }
    return undefined
  }, [fetchSlowQueries, refreshIntervalSeconds])

  const sortedQueries = [...queries].sort((a, b) => {
    const multiplier = sortDirection === "desc" ? -1 : 1
    return (a[sortField] - b[sortField]) * multiplier
  })

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection((prev) => (prev === "desc" ? "asc" : "desc"))
    } else {
      setSortField(field)
      setSortDirection("desc")
    }
  }

  if (loading) return <LoadingRows />
  if (error) return <ErrorBanner message={`Failed to load slow queries: ${error}`} onRetry={() => void fetchSlowQueries()} />
  if (queries.length === 0) {
    const threshold = formatDuration(minDurationMs)
    return <EmptyState title="No slow queries" description={`No slow queries found (threshold: ${threshold}). Queries exceeding log_min_duration_statement will appear here.`} />
  }

  const sort: SortState = { field: sortField, direction: sortDirection, onSort: handleSort }
  const toggle = (id: string): void => { setExpandedQueryId((prev) => (prev === id ? null : id)) }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium text-foreground">Slow Query Log</h3>
        <span className="text-xs text-muted-foreground">
          {queries.length} {queries.length === 1 ? "query" : "queries"} above {formatDuration(minDurationMs)}
        </span>
        <Button size="xs" className="ml-auto" onClick={() => void fetchSlowQueries()}>Refresh</Button>
      </div>
      <TableCard head={<SlowQueryHead sort={sort} />}>
        {sortedQueries.map((q) => (
          <SlowQueryRow key={q.queryId} query={q} expanded={expandedQueryId === q.queryId} onToggle={() => { toggle(q.queryId) }} />
        ))}
      </TableCard>
    </div>
  )
}

// -- Table parts -------------------------------------------------------------

/** Which column the log is sorted by, which way, and how a header changes it. */
interface SortState {
  field: SortField
  direction: SortDirection
  onSort: (field: SortField) => void
}

/** The sortable columns, in order, with their headings. */
const SORTABLE: Array<[SortField, string]> = [
  ["totalTimeMs", "Total Time"],
  ["meanTimeMs", "Mean"],
  ["maxTimeMs", "Max"],
  ["calls", "Calls"],
  ["rows", "Rows"],
]

function SlowQueryHead({ sort }: { sort: SortState }): ReactElement {
  return (
    <>
      <Th>Query</Th>
      {SORTABLE.map(([field, label]) => <SortHeader key={field} field={field} label={label} sort={sort} />)}
      <Th>Time %</Th>
    </>
  )
}

/** A column heading that sorts by its column, saying which way it is sorted (`aria-sort`). */
function SortHeader({ field, label, sort }: { field: SortField; label: string; sort: SortState }): ReactElement {
  const active = field === sort.field
  const arrow = active ? (sort.direction === "desc" ? " ↓" : " ↑") : ""
  return (
    <Th aria-sort={active ? (sort.direction === "desc" ? "descending" : "ascending") : "none"}>
      <TextLink tone="muted" className="uppercase tracking-wider" onClick={() => { sort.onSort(field) }}>{label}{arrow}</TextLink>
    </Th>
  )
}

/**
 * One statement and its timings. The whole row toggles the full statement, as it always has; the
 * statement cell is also a disclosure button, so a keyboard reaches the same toggle (its click
 * bubbles to the row, which does the toggling).
 */
function SlowQueryRow({ query: q, expanded, onToggle }: { query: SlowQuery; expanded: boolean; onToggle: () => void }): ReactElement {
  return (
    <tr className={tableRowClass(true)} onClick={onToggle}>
      <Td className="font-mono text-xs">
        <DisclosureButton open={expanded} className="items-start">
          {expanded ? <pre className="whitespace-pre-wrap break-words">{q.query}</pre> : <code>{truncateQuery(q.query)}</code>}
        </DisclosureButton>
      </Td>
      <Td>{formatDuration(q.totalTimeMs)}</Td>
      <Td>{formatDuration(q.meanTimeMs)}</Td>
      <Td>{formatDuration(q.maxTimeMs)}</Td>
      <Td>{q.calls.toLocaleString()}</Td>
      <Td>{q.rows.toLocaleString()}</Td>
      <Td><TimeShare pct={q.timePct} /></Td>
    </tr>
  )
}

/** This statement's share of all database time, as a bar and a figure. */
function TimeShare({ pct }: { pct: number }): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{pct.toFixed(1)}%</span>
    </div>
  )
}
