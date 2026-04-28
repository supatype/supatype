/**
 * Slow query log component.
 *
 * Displays slow queries captured by Postgres `pg_stat_statements`.
 * The host app provides a `onRunQuery` callback to execute SQL.
 */

import { useCallback, useEffect, useState } from "react"

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

function buildSlowQuerySQL(minDurationMs: number, limit: number): string {
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
    ORDER BY total_exec_time DESC
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
      const sql = buildSlowQuerySQL(minDurationMs, limit)
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
  }, [onRunQuery, minDurationMs, limit])

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

  const sortIndicator = (field: SortField) => {
    if (field !== sortField) return ""
    return sortDirection === "desc" ? " \u2193" : " \u2191"
  }

  if (loading) {
    return <div className="slow-query-log slow-query-log--loading">Loading slow queries...</div>
  }

  if (error) {
    return (
      <div className="slow-query-log slow-query-log--error">
        <p>Failed to load slow queries: {error}</p>
        <button onClick={() => void fetchSlowQueries()}>Retry</button>
      </div>
    )
  }

  if (queries.length === 0) {
    return (
      <div className="slow-query-log slow-query-log--empty">
        <p>
          No slow queries found (threshold: {formatDuration(minDurationMs)}).
        </p>
        <p>
          Queries exceeding <code>log_min_duration_statement</code> will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="slow-query-log">
      <div className="slow-query-log__header">
        <h3>Slow Query Log</h3>
        <span className="slow-query-log__count">
          {queries.length} {queries.length === 1 ? "query" : "queries"} above {formatDuration(minDurationMs)}
        </span>
        <button
          className="slow-query-log__refresh"
          onClick={() => void fetchSlowQueries()}
        >
          Refresh
        </button>
      </div>

      <table className="slow-query-log__table">
        <thead>
          <tr>
            <th>Query</th>
            <th className="slow-query-log__sortable" onClick={() => handleSort("totalTimeMs")}>
              Total Time{sortIndicator("totalTimeMs")}
            </th>
            <th className="slow-query-log__sortable" onClick={() => handleSort("meanTimeMs")}>
              Mean{sortIndicator("meanTimeMs")}
            </th>
            <th className="slow-query-log__sortable" onClick={() => handleSort("maxTimeMs")}>
              Max{sortIndicator("maxTimeMs")}
            </th>
            <th className="slow-query-log__sortable" onClick={() => handleSort("calls")}>
              Calls{sortIndicator("calls")}
            </th>
            <th className="slow-query-log__sortable" onClick={() => handleSort("rows")}>
              Rows{sortIndicator("rows")}
            </th>
            <th>Time %</th>
          </tr>
        </thead>
        <tbody>
          {sortedQueries.map((q) => (
            <tr
              key={q.queryId}
              className={expandedQueryId === q.queryId ? "slow-query-log__row--expanded" : ""}
              onClick={() =>
                setExpandedQueryId((prev) => (prev === q.queryId ? null : q.queryId))
              }
            >
              <td className="slow-query-log__query">
                {expandedQueryId === q.queryId ? (
                  <pre>{q.query}</pre>
                ) : (
                  <code>{truncateQuery(q.query)}</code>
                )}
              </td>
              <td>{formatDuration(q.totalTimeMs)}</td>
              <td>{formatDuration(q.meanTimeMs)}</td>
              <td>{formatDuration(q.maxTimeMs)}</td>
              <td>{q.calls.toLocaleString()}</td>
              <td>{q.rows.toLocaleString()}</td>
              <td>
                <div className="slow-query-log__bar">
                  <div
                    className="slow-query-log__bar-fill"
                    style={{ width: `${Math.min(q.timePct, 100)}%` }}
                  />
                  <span>{q.timePct.toFixed(1)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
