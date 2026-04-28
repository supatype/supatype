import React, { useState, useMemo } from "react"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, Input, Select, Th, Td } from "../components/ui.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"

// ─── Types ────────────────────────────────────────────────────────────────────

type MigrationStatus = "applied" | "rolled_back"

interface AstField {
  kind: string
  pgType: string
  required?: boolean
}

interface AstModel {
  name: string
  tableName: string
  fields: Record<string, AstField>
  options?: { timestamps?: boolean; softDelete?: boolean }
}

interface AstSnapshot {
  models: AstModel[]
}

type ChangeKind = "added" | "removed" | "modified"

interface FieldChange {
  kind: ChangeKind
  name: string
  from?: string
  to?: string
}

interface ModelChange {
  kind: ChangeKind
  name: string
  tableName: string
  fieldChanges: FieldChange[]
}

interface Migration {
  id: number
  name: string
  hash: string
  applied_at: string
  rolled_back: boolean
  rolled_back_at: string | null
  engine_version: string
  schema_snapshot: AstSnapshot | null
  sql_up: string | null
}

const statusVariant: Record<MigrationStatus, "green" | "yellow"> = {
  applied: "green",
  rolled_back: "yellow",
}

function mapMigrationRow(row: Record<string, unknown>): Migration {
  let snapshot: AstSnapshot | null = null
  const raw = row["schema_snapshot"]
  if (raw && typeof raw === "object") snapshot = raw as AstSnapshot
  return {
    id: Number(row["id"] ?? 0),
    name: String(row["name"] ?? ""),
    hash: String(row["hash"] ?? ""),
    applied_at: String(row["applied_at"] ?? ""),
    rolled_back: row["rolled_back"] === true || row["rolled_back"] === "t",
    rolled_back_at: (row["rolled_back_at"] as string | null) ?? null,
    engine_version: String(row["engine_version"] ?? ""),
    schema_snapshot: snapshot,
    sql_up: (row["sql_up"] as string | null) ?? null,
  }
}

// ─── Snapshot diff ────────────────────────────────────────────────────────────

function diffSnapshots(prev: AstSnapshot | null, curr: AstSnapshot | null): ModelChange[] {
  if (!curr) return []
  const changes: ModelChange[] = []
  const prevMap = new Map<string, AstModel>((prev?.models ?? []).map((m) => [m.name, m]))
  const currMap = new Map<string, AstModel>(curr.models.map((m) => [m.name, m]))

  for (const [name, model] of currMap) {
    if (!prevMap.has(name)) {
      changes.push({ kind: "added", name, tableName: model.tableName, fieldChanges: [] })
    }
  }
  for (const [name, model] of prevMap) {
    if (!currMap.has(name)) {
      changes.push({ kind: "removed", name, tableName: model.tableName, fieldChanges: [] })
    }
  }
  for (const [name, currModel] of currMap) {
    const prevModel = prevMap.get(name)
    if (!prevModel) continue
    const fieldChanges: FieldChange[] = []
    for (const [f, cf] of Object.entries(currModel.fields)) {
      const pf = prevModel.fields[f]
      if (!pf) fieldChanges.push({ kind: "added", name: f, to: cf.pgType })
      else if (pf.pgType !== cf.pgType) fieldChanges.push({ kind: "modified", name: f, from: pf.pgType, to: cf.pgType })
    }
    for (const f of Object.keys(prevModel.fields)) {
      if (!currModel.fields[f]) fieldChanges.push({ kind: "removed", name: f, from: prevModel.fields[f]!.pgType })
    }
    if (fieldChanges.length > 0) changes.push({ kind: "modified", name, tableName: currModel.tableName, fieldChanges })
  }
  return changes
}

// ─── Change display ───────────────────────────────────────────────────────────

const kindColor: Record<ChangeKind, string> = {
  added: "text-green-400",
  removed: "text-red-400",
  modified: "text-yellow-400",
}

function ChangeSummaryPills({ changes, hasSnapshot }: { changes: ModelChange[]; hasSnapshot: boolean }): React.ReactElement {
  const added = changes.filter((c) => c.kind === "added").length
  const removed = changes.filter((c) => c.kind === "removed").length
  const modified = changes.filter((c) => c.kind === "modified").length
  if (changes.length === 0) {
    return (
      <span className="text-[0.65rem] text-muted-foreground/40" title={hasSnapshot ? "Same schema as previous push" : "No snapshot recorded"}>
        no change
      </span>
    )
  }
  return (
    <div className="flex gap-1.5">
      {added > 0 && <span className="text-[0.65rem] font-mono text-green-400">+{added}</span>}
      {removed > 0 && <span className="text-[0.65rem] font-mono text-red-400">−{removed}</span>}
      {modified > 0 && <span className="text-[0.65rem] font-mono text-yellow-400">~{modified}</span>}
    </div>
  )
}

function ChangeList({ changes }: { changes: ModelChange[] }): React.ReactElement {
  if (changes.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No schema changes recorded.</p>
  }
  return (
    <div className="space-y-2.5">
      {changes.map((c) => (
        <div key={c.name}>
          <div className="flex items-center gap-2">
            <span className={cn("text-[0.65rem] font-mono font-semibold w-16 flex-shrink-0", kindColor[c.kind])}>
              {c.kind === "added" ? "+ added" : c.kind === "removed" ? "− removed" : "~ modified"}
            </span>
            <span className="text-sm font-medium">{c.name}</span>
            <code className="text-[0.65rem] text-muted-foreground">{c.tableName}</code>
          </div>
          {c.fieldChanges.length > 0 && (
            <div className="ml-[72px] mt-1 space-y-0.5">
              {c.fieldChanges.map((f) => (
                <div key={f.name} className="flex items-center gap-1.5 text-[0.7rem] font-mono text-muted-foreground">
                  <span className={kindColor[f.kind]}>{f.kind === "added" ? "+" : f.kind === "removed" ? "−" : "~"}</span>
                  <span>{f.name}</span>
                  {f.from && <span className="text-red-400/70 line-through">{f.from}</span>}
                  {f.to && <span className="text-green-400/70">{f.to}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── SQL block ────────────────────────────────────────────────────────────────

function SqlBlock({ sql }: { sql: string }): React.ReactElement {
  return (
    <div className="rounded-md border border-border bg-background overflow-x-auto">
      <pre className="p-3 text-[0.7rem] font-mono text-foreground/80 whitespace-pre leading-relaxed">
        {sql.split("\n").map((line, i) => (
          <div key={i} className={cn(
            line.trimStart().startsWith("--") ? "text-muted-foreground/50" :
            /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|SET)\b/i.test(line.trimStart()) ? "text-primary/90" :
            "text-foreground/80"
          )}>{line || " "}</div>
        ))}
      </pre>
    </div>
  )
}

// ─── Inline expanded row ──────────────────────────────────────────────────────

function ExpandedRow({ migration, changes, colSpan }: {
  migration: Migration
  changes: ModelChange[]
  colSpan: number
}): React.ReactElement {
  const [tab, setTab] = useState<"changes" | "sql">("changes")
  const hasChanges = changes.length > 0
  const hasSql = !!migration.sql_up

  return (
    <tr className="bg-accent/20 border-b border-border">
      <td colSpan={colSpan} className="px-4 py-3">
        {(hasChanges || hasSql) && (
          <div className="flex gap-3 mb-3 border-b border-border/40 pb-2">
            <button
              onClick={() => setTab("changes")}
              className={cn("text-xs pb-1 border-b-2 transition-colors", tab === "changes" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              Schema changes
            </button>
            {hasSql && (
              <button
                onClick={() => setTab("sql")}
                className={cn("text-xs pb-1 border-b-2 transition-colors", tab === "sql" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
              >
                SQL
              </button>
            )}
          </div>
        )}
        {tab === "changes" && <ChangeList changes={changes} />}
        {tab === "sql" && migration.sql_up && <SqlBlock sql={migration.sql_up} />}
        <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-4 text-[0.7rem] text-muted-foreground font-mono">
          <span>hash: {migration.hash.slice(0, 16)}…</span>
          {migration.rolled_back_at && (
            <span>rolled back: {new Date(migration.rolled_back_at).toLocaleString()}</span>
          )}
        </div>
      </td>
    </tr>
  )
}

// ─── Slide-out panel ──────────────────────────────────────────────────────────

function SlideOutPanel({ migration, changes, onClose }: {
  migration: Migration
  changes: ModelChange[]
  onClose: () => void
}): React.ReactElement {
  const [tab, setTab] = useState<"changes" | "sql">("changes")
  const status: MigrationStatus = migration.rolled_back ? "rolled_back" : "applied"
  const hasSql = !!migration.sql_up
  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-[420px] z-50 bg-card border-l border-border flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <p className="text-xs text-muted-foreground font-mono mb-0.5">Migration #{migration.id}</p>
            <h3 className="text-sm font-semibold leading-snug break-all">{migration.name}</h3>
            <div className="flex items-center gap-2 mt-1.5">
              <Badge variant={statusVariant[status]}>{status.replace("_", " ")}</Badge>
              <span className="text-xs text-muted-foreground font-mono">{migration.engine_version}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors flex-shrink-0 ml-2"
          >
            ✕
          </button>
        </div>

        {/* Meta */}
        <div className="px-5 pt-4 pb-3 border-b border-border/40 flex-shrink-0 space-y-1">
          <div className="flex justify-between text-[0.7rem] text-muted-foreground">
            <span>Applied</span>
            <span>{new Date(migration.applied_at).toLocaleString()}</span>
          </div>
          {migration.rolled_back_at && (
            <div className="flex justify-between text-[0.7rem] text-muted-foreground">
              <span>Rolled back</span>
              <span>{new Date(migration.rolled_back_at).toLocaleString()}</span>
            </div>
          )}
          <div className="flex justify-between text-[0.7rem] text-muted-foreground font-mono">
            <span>Hash</span>
            <span>{migration.hash.slice(0, 16)}…</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 px-5 pt-3 border-b border-border/40 flex-shrink-0">
          <button
            onClick={() => setTab("changes")}
            className={cn("text-xs pb-2 border-b-2 transition-colors", tab === "changes" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            Schema changes
          </button>
          {hasSql && (
            <button
              onClick={() => setTab("sql")}
              className={cn("text-xs pb-2 border-b-2 transition-colors", tab === "sql" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              SQL
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "changes" && <ChangeList changes={changes} />}
          {tab === "sql" && migration.sql_up && <SqlBlock sql={migration.sql_up} />}
        </div>
      </div>
    </>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function MigrationHistory(): React.ReactElement {
  const proxy = useProjectProxy()

  const { data: migrationsData, loading, error, refetch } = useApiQuery(
    async () => {
      const result = await proxy.sql(
        `SELECT id, name, hash, applied_at::TEXT, rolled_back, rolled_back_at::TEXT,
                engine_version, schema_snapshot, sql_up
         FROM _supatype.migrations ORDER BY id ASC`,
      )
      return result.rows.map(mapMigrationRow)
    },
    [proxy],
  )

  const migrations = migrationsData ?? []
  const displayMigrations = useMemo(() => [...migrations].reverse(), [migrations])

  const diffs = useMemo(() => {
    const map = new Map<number, ModelChange[]>()
    for (let i = 0; i < migrations.length; i++) {
      const curr = migrations[i]!
      const prev = i > 0 ? migrations[i - 1]!.schema_snapshot : null
      map.set(curr.id, diffSnapshots(prev, curr.schema_snapshot))
    }
    return map
  }, [migrations])

  // Inline expanded row id
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // Slide-out panel migration
  const [slideOut, setSlideOut] = useState<Migration | null>(null)

  const [search, setSearch] = useState("")
  const [filterStatus, setFilterStatus] = useState("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  const filtered = useMemo(() => {
    return displayMigrations.filter((m) => {
      const status: MigrationStatus = m.rolled_back ? "rolled_back" : "applied"
      if (search && !m.name.toLowerCase().includes(search.toLowerCase()) && !String(m.id).includes(search)) return false
      if (filterStatus !== "all" && status !== filterStatus) return false
      if (dateFrom && new Date(m.applied_at) < new Date(dateFrom)) return false
      if (dateTo && new Date(m.applied_at) > new Date(dateTo + "T23:59:59Z")) return false
      return true
    })
  }, [displayMigrations, search, filterStatus, dateFrom, dateTo])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-muted-foreground">Loading migrations...</span>
      </div>
    )
  }

  if (error) {
    if (error.includes("does not exist")) {
      return (
        <EmptyState
          title="No migrations yet"
          description="Run `supatype push` to apply your schema and start tracking migrations."
          action={refetch}
          actionLabel="Refresh"
        />
      )
    }
    return <ErrorBanner message={error} onRetry={refetch} />
  }

  if (migrations.length === 0) {
    return (
      <EmptyState
        title="No migrations found"
        description="No migrations have been applied yet."
        action={refetch}
        actionLabel="Refresh"
      />
    )
  }

  return (
    <>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Input
          className="w-[280px]"
          placeholder="Search by name or id..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-[140px]" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All status</option>
          <option value="applied">Applied</option>
          <option value="rolled_back">Rolled back</option>
        </Select>
        <div className="flex items-center gap-1">
          <label className="text-xs text-muted-foreground">From:</label>
          <Input type="date" className="w-[140px]" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div className="flex items-center gap-1">
          <label className="text-xs text-muted-foreground">To:</label>
          <Input type="date" className="w-[140px]" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th className="w-6" />
              <Th>ID</Th>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Changes</Th>
              <Th>Applied At</Th>
              <Th>Engine</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const status: MigrationStatus = m.rolled_back ? "rolled_back" : "applied"
              const changes = diffs.get(m.id) ?? []
              const isExpanded = expandedId === m.id
              return (
                <React.Fragment key={m.id}>
                  <tr
                    className={cn(
                      "border-b border-border hover:bg-accent/50 cursor-pointer",
                      isExpanded && "bg-accent/30"
                    )}
                    onClick={() => setExpandedId(isExpanded ? null : m.id)}
                  >
                    <Td className="text-muted-foreground text-xs pl-3 pr-0">
                      {isExpanded ? "▾" : "▸"}
                    </Td>
                    <Td className="font-mono text-muted-foreground">{m.id}</Td>
                    <Td className="font-medium">{m.name}</Td>
                    <Td><Badge variant={statusVariant[status]}>{status.replace("_", " ")}</Badge></Td>
                    <Td><ChangeSummaryPills changes={changes} hasSnapshot={m.schema_snapshot !== null} /></Td>
                    <Td className="text-xs text-muted-foreground">{new Date(m.applied_at).toLocaleString()}</Td>
                    <Td className="text-xs text-muted-foreground font-mono">{m.engine_version}</Td>
                    <Td>
                      <Button
                        size="xs"
                        onClick={(e) => { e.stopPropagation(); setSlideOut(m) }}
                      >
                        Details
                      </Button>
                    </Td>
                  </tr>
                  {isExpanded && (
                    <ExpandedRow migration={m} changes={changes} colSpan={8} />
                  )}
                </React.Fragment>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-8 text-muted-foreground text-sm">
                  No migrations match your filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="text-xs text-muted-foreground mt-2">
        {filtered.length} of {migrations.length} migrations shown
      </div>

      {/* Slide-out panel */}
      {slideOut && (
        <SlideOutPanel
          migration={slideOut}
          changes={diffs.get(slideOut.id) ?? []}
          onClose={() => setSlideOut(null)}
        />
      )}
    </>
  )
}
