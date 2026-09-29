/**
 * What has been seeded into this environment, and when.
 *
 * `_supatype.seeds` is to seeds what `_supatype.migrations` is to migrations, so this screen
 * is built from `MigrationHistory.tsx`: the same primitives, the same data route through
 * `useApiQuery` and `proxy.sql`, and no new engine endpoint. The ledger is a table, and
 * Studio already reads `_supatype.migrations` this way.
 *
 * Two things earn their place beyond a plain listing:
 *
 * **Drift.** A file whose latest run used a different document than the run before it has
 * changed since it was applied. That is the question this screen exists to answer, and it
 * cannot be answered from one row, so the drift check compares a file's two most recent runs.
 *
 * **Rows written**, expanded per model, so a run that quietly wrote nothing looks different
 * from one that wrote everything.
 *
 * A `rolled_back` run is shown, not hidden. A seed that failed is the thing an author most
 * wants to see, and omitting it would make this screen agree with a database that disagrees
 * with it.
 */

import React, { useMemo } from "react"
import { Badge, Card, Td, Th } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"

// --- Types ---

export type SeedStatus = "committed" | "rolled_back"

export interface SeedRun {
  id: number
  /** The seed file, relative to the project root: what links a row back to its source. */
  file: string
  ir_hash: string
  schema_fingerprint: string
  applied_at: string
  duration_ms: number
  status: SeedStatus
  /** Model name to rows written. */
  rows_written: Record<string, number>
  error_message: string | null
  engine_version: string
}

/** A run, with what can only be known by looking at the one before it. */
export interface SeedRunRow extends SeedRun {
  /** This is the most recent run of its file. */
  latest: boolean
  /** The latest run of this file used a different document than the run before it. */
  drifted: boolean
}

export const SEEDS_LIST_SQL = `SELECT id, file, ir_hash, schema_fingerprint, applied_at::TEXT,
       duration_ms, status, rows_written, error_message, engine_version
 FROM _supatype.seeds ORDER BY applied_at DESC, id DESC`

const statusVariant: Record<SeedStatus, "green" | "red"> = {
  committed: "green",
  // Red rather than the yellow a rolled-back migration gets: that is a deliberate
  // operation, and this is a seed that failed.
  rolled_back: "red",
}

// --- Reading the ledger ---

/** One row of `_supatype.seeds`, which arrives as whatever the proxy decoded. */
export function mapSeedRow(row: Record<string, unknown>): SeedRun {
  return {
    id: Number(row["id"] ?? 0),
    file: String(row["file"] ?? ""),
    ir_hash: String(row["ir_hash"] ?? ""),
    schema_fingerprint: String(row["schema_fingerprint"] ?? ""),
    applied_at: String(row["applied_at"] ?? ""),
    duration_ms: Number(row["duration_ms"] ?? 0),
    status: row["status"] === "rolled_back" ? "rolled_back" : "committed",
    rows_written: asCounts(row["rows_written"]),
    error_message: (row["error_message"] as string | null) ?? null,
    engine_version: String(row["engine_version"] ?? ""),
  }
}

/**
 * `rows_written` is JSONB, and a proxy may hand it back decoded or as text.
 *
 * Both are handled rather than one assumed: the difference between them is a screen that
 * says a run wrote nothing and a run that wrote plenty.
 */
function asCounts(value: unknown): Record<string, number> {
  const source: unknown =
    typeof value === "string" ? safeParse(value) : value
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {}
  const out: Record<string, number> = {}
  for (const [model, count] of Object.entries(source as Record<string, unknown>)) {
    const n = Number(count)
    if (Number.isFinite(n)) out[model] = n
  }
  return out
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Mark each run as the latest of its file, and whether that latest one has drifted.
 *
 * Drift is a property of a file, not of a run, so it is worked out from the whole history
 * and shown on the row a reader is looking at when they ask the question.
 */
export function markRuns(runs: readonly SeedRun[]): SeedRunRow[] {
  const seen = new Set<string>()
  const byFile = new Map<string, SeedRun[]>()
  for (const run of runs) {
    const history = byFile.get(run.file)
    if (history === undefined) byFile.set(run.file, [run])
    else history.push(run)
  }

  return runs.map((run) => {
    const latest = !seen.has(run.file)
    seen.add(run.file)
    const history = byFile.get(run.file) ?? []
    // Already newest first, so the run before this file's latest is at index 1. One run
    // cannot have drifted: there is nothing to have drifted from.
    const previous = history[1]
    const drifted =
      latest && previous !== undefined && previous.ir_hash !== run.ir_hash
    return { ...run, latest, drifted }
  })
}

/** `Organiser 2, Event 1`, or nothing at all when a run wrote nothing. */
export function rowsWrittenSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([model, written]) => `${model} ${written}`)
    .join(", ")
}

function shortHash(hash: string): string {
  const withoutAlgorithm = hash.startsWith("sha256:") ? hash.slice(7) : hash
  return withoutAlgorithm.slice(0, 8)
}

// --- The screen ---

export interface SeedHistoryViewProps {
  runs: SeedRunRow[] | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}

/** The file, and whether what ran under that name has since changed. */
function FileCell({ run }: { run: SeedRunRow }): React.ReactElement {
  return (
    <Td className="font-medium">
      <span title={run.file}>{run.file}</span>
      {run.drifted && (
        <Badge variant="yellow" className="ml-2">
          changed since it ran
        </Badge>
      )}
    </Td>
  )
}

/** How the run ended, and what it said if it failed. */
function StatusCell({ run }: { run: SeedRunRow }): React.ReactElement {
  return (
    <Td>
      <Badge variant={statusVariant[run.status]}>{run.status.replace("_", " ")}</Badge>
      {run.error_message !== null && (
        <span className="ml-2 text-xs text-muted-foreground" title={run.error_message}>
          {run.error_message}
        </span>
      )}
    </Td>
  )
}

function RunRow({ run }: { run: SeedRunRow }): React.ReactElement {
  return (
    <tr className="border-b border-border hover:bg-accent/50">
      <FileCell run={run} />
      <StatusCell run={run} />
      {/* Named rather than left blank: an empty cell reads as "no data" rather than as a
          run that did nothing, and telling those apart is half the point of the column. */}
      <Td className="text-xs text-muted-foreground">
        {rowsWrittenSummary(run.rows_written) || "nothing"}
      </Td>
      <Td className="text-xs text-muted-foreground">{run.applied_at}</Td>
      <Td className="text-xs text-muted-foreground">{run.duration_ms}ms</Td>
      <Td className="font-mono text-xs text-muted-foreground">
        <span title={run.ir_hash}>{shortHash(run.ir_hash)}</span>
      </Td>
      <Td className="text-xs text-muted-foreground">{run.engine_version}</Td>
    </tr>
  )
}

function RunTable({ runs }: { runs: readonly SeedRunRow[] }): React.ReactElement {
  return (
    <Card className="overflow-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <Th>File</Th>
            <Th>Status</Th>
            <Th>Rows written</Th>
            <Th>Applied at</Th>
            <Th>Duration</Th>
            <Th>Document</Th>
            <Th>Engine</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </tbody>
      </table>
    </Card>
  )
}

/**
 * Everything the screen shows, given what it shows it.
 *
 * Separated from the fetching so every state it can be in is one a test can render: the
 * empty one most of all, because that is the state a new project is in and so the one most
 * likely to be written and never looked at.
 */
export function SeedHistoryView({
  runs,
  loading,
  error,
  onRefresh,
}: SeedHistoryViewProps): React.ReactElement {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-muted-foreground">Loading seed runs...</span>
      </div>
    )
  }

  // The ledger table is created alongside `_supatype.migrations`, so its absence means this
  // database predates seeding rather than anything being broken.
  if (error !== null && !error.includes("does not exist")) {
    return <ErrorBanner message={error} onRetry={onRefresh} />
  }

  const rows = error !== null ? [] : (runs ?? [])
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No seeds have run here"
        description="Run `supatype seed` to apply your seed data. Every run is recorded here with what it wrote."
        action={onRefresh}
        actionLabel="Refresh"
      />
    )
  }

  return <RunTable runs={rows} />
}

export function SeedHistory(): React.ReactElement {
  const proxy = useProjectProxy()

  const { data, loading, error, refetch } = useApiQuery(async () => {
    const result = await proxy.sql(SEEDS_LIST_SQL)
    return result.rows.map(mapSeedRow)
  }, [proxy])

  const runs = useMemo(() => (data === null ? null : markRuns(data)), [data])

  return (
    <SeedHistoryView
      runs={runs}
      loading={loading}
      error={error}
      onRefresh={refetch}
    />
  )
}
