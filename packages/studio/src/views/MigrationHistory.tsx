import React, { useState, useMemo, useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { isMissingTable } from "../lib/database-error.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, Input, Select, Th, Td } from "../components/ui.js"
import { useProjectProxy, type ProjectProxy } from "../hooks/useProjectProxy.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { isJsonObject, safeParseJson } from "../lib/json.js"
import {
  MIGRATION_STATUSES,
  MIGRATION_STATUS_VARIANT,
  migrationOutcome,
  migrationStatusLabel,
  type MigrationOutcome,
} from "../lib/migration-outcome.js"
import { RefusalHints, RefusalOperations, withoutForceAdvice } from "../components/PushRefusalDetails.js"

// ─── Types ────────────────────────────────────────────────────────────────────


/** What the change summary reads from a migration's schema snapshot: names and Postgres types. */
interface AstField {
  pgType: string
}

interface AstModel {
  name: string
  tableName: string
  fields: Record<string, AstField>
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

/** A rename a migration applied, with who declared it (the rename journal) and when. */
interface AppliedRename {
  kind: string
  table: string
  from: string
  to: string
  declared_by: string | null
  declared_at: string | null
}

/** Who pushed a migration, through what and from where (the audit trail). */
interface MigrationAuthor {
  /** Verified when a control plane authenticated them; the client's own claim otherwise. */
  pushed_by: string | null
  pushed_by_verified: boolean | null
  /** `cli`, `studio`, `cloud` or `self-host`. */
  pushed_via: string | null
  pushed_from: string | null
}

interface Migration extends MigrationAuthor {
  id: number
  name: string
  hash: string
  applied_at: string
  rolled_back: boolean
  rolled_back_at: string | null
  engine_version: string
  schema_snapshot: AstSnapshot | null
  has_sql: boolean
  sql_up: string | null
  renames: AppliedRename[]
  /** Applied, failed, refused or rolled back, and why when it did not apply. */
  outcome: MigrationOutcome
}

/** Whether a migration's push applied a schema: a failed or refused one applied nothing. */
function appliedSchema(m: Migration): boolean {
  return m.outcome.status !== "failed" && m.outcome.status !== "refused"
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function boolOrNull(value: unknown): boolean | null {
  if (value === true || value === "t" || value === "true") return true
  if (value === false || value === "f" || value === "false") return false
  return null
}

/** The `renames` column, which arrives as JSON or as its text depending on the proxy. */
function mapRenames(raw: unknown): AppliedRename[] {
  const value = typeof raw === "string" ? safeParseJson(raw) : raw
  if (!Array.isArray(value)) return []
  return value
    .filter(isJsonObject)
    .map((r) => ({
      kind: String(r["kind"] ?? "column"),
      table: String(r["table"] ?? ""),
      from: String(r["from"] ?? ""),
      to: String(r["to"] ?? ""),
      declared_by: textOrNull(r["declared_by"]),
      declared_at: textOrNull(r["declared_at"]),
    }))
}

/** The author columns, falling back to the manifest's `pushedBy` (always the client's claim). */
function mapAuthor(row: Record<string, unknown>): MigrationAuthor {
  const pushedBy = textOrNull(row["pushed_by"])
  return {
    pushed_by: pushedBy ?? textOrNull(row["manifest_pushed_by"]),
    pushed_by_verified: pushedBy === null ? null : boolOrNull(row["pushed_by_verified"]),
    pushed_via: textOrNull(row["pushed_via"]),
    pushed_from: textOrNull(row["pushed_from"]),
  }
}

/**
 * A name a snapshot node carries. The engine's v2 AST keeps a model's table name and a field's
 * Postgres type under `annotations.db`; older snapshots, and the tests, carry them flat.
 */
function snapshotName(node: Record<string, unknown>, key: string): string {
  const flat = node[key]
  if (typeof flat === "string") return flat
  const annotations = node["annotations"]
  const db = isJsonObject(annotations) ? annotations["db"] : undefined
  const nested = isJsonObject(db) ? db[key] : undefined
  return typeof nested === "string" ? nested : ""
}

function mapSnapshotModel(model: Record<string, unknown>): AstModel {
  const rawFields = model["fields"]
  const fields: Record<string, AstField> = {}
  if (isJsonObject(rawFields)) {
    for (const [name, field] of Object.entries(rawFields)) {
      if (isJsonObject(field)) fields[name] = { pgType: snapshotName(field, "pgType") }
    }
  }
  return { name: String(model["name"] ?? ""), tableName: snapshotName(model, "tableName"), fields }
}

/** The `schema_snapshot` column: the AST the engine pushed, or null when the row has none. */
function mapSnapshot(raw: unknown): AstSnapshot | null {
  if (!isJsonObject(raw)) return null
  const models = raw["models"]
  return { models: Array.isArray(models) ? models.filter(isJsonObject).map(mapSnapshotModel) : [] }
}

function textColumn(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function mapMigrationRow(row: Record<string, unknown>): Migration {
  const snapshot = mapSnapshot(row["schema_snapshot"])
  const legacySql = textColumn(row["sql_up"])
  const hasSql =
    row["has_sql"] === true ||
    row["has_sql"] === "t" ||
    (legacySql?.trim().length ?? 0) > 0
  return {
    id: Number(row["id"] ?? 0),
    name: String(row["name"] ?? ""),
    hash: String(row["hash"] ?? ""),
    applied_at: String(row["applied_at"] ?? ""),
    rolled_back: row["rolled_back"] === true || row["rolled_back"] === "t",
    rolled_back_at: textColumn(row["rolled_back_at"]),
    engine_version: String(row["engine_version"] ?? ""),
    schema_snapshot: snapshot,
    has_sql: hasSql,
    sql_up: legacySql,
    ...mapAuthor(row),
    renames: mapRenames(row["renames"]),
    outcome: migrationOutcome(row),
  }
}

/** The migrations ledger, as Postgres names it in a missing-relation error. */
const MIGRATIONS_TABLE = "_supatype.migrations"

/**
 * The metadata query for the history (RQ3b): with the audit columns where it has them, and nulls
 * where an engine from before them wrote it, so an older history reads as "no author recorded"
 * rather than failing the whole query.
 */
export function migrationsQuery(audited: boolean): "migrations" | "migrations_legacy" {
  return audited ? "migrations" : "migrations_legacy"
}

/**
 * Candidates for display: DDL rows, initial baseline, and every push that failed or was refused,
 * not legacy admin_refresh noise. A refused push records its statements apart from `sql_up`.
 */
function isTrackedMigration(m: Migration): boolean {
  if (m.name.startsWith("admin_refresh_")) return false
  if (m.has_sql || !appliedSchema(m)) return true
  return m.name.startsWith("initial_")
}

/**
 * Each tracked migration with what it changed from the schema before it: the snapshot of the last
 * push before it that applied one. A failed or refused push applied nothing and records no
 * snapshot, so it changes nothing and is not what the push after it is compared with.
 */
function changesByMigration(tracked: Migration[]): Map<number, ModelChange[]> {
  const changes = new Map<number, ModelChange[]>()
  let previous: AstSnapshot | null = null
  for (const m of tracked) {
    if (!appliedSchema(m)) {
      changes.set(m.id, [])
      continue
    }
    changes.set(m.id, diffSnapshots(previous, m.schema_snapshot))
    if (m.schema_snapshot !== null) previous = m.schema_snapshot
  }
  return changes
}

/**
 * Only show migrations where the schema actually changed vs the previous applied one, and every
 * push that failed or was refused: those are what the history is read for.
 */
function buildVisibleMigrations(tracked: Migration[]): Migration[] {
  const changes = changesByMigration(tracked)
  let shownApplied = false
  return tracked.filter((m) => {
    if (!appliedSchema(m)) return true
    const shown = !shownApplied || isInitialBaseline(m) || (changes.get(m.id)?.length ?? 0) > 0
    shownApplied ||= shown
    return shown
  })
}

function useMigrationSql(
  proxy: ProjectProxy,
  migrationId: number,
  hasSql: boolean,
  enabled: boolean,
): { sql: string | null; loading: boolean; error: string | null } {
  const [sql, setSql] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !hasSql) {
      setSql(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void proxy
      .metadata("migration_sql", { id: String(migrationId) })
      .then((result) => {
        if (cancelled) return
        const row = result.rows[0]
        const value = row?.["sql_up"]
        setSql(typeof value === "string" ? value : null)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load SQL")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [proxy, migrationId, hasSql, enabled])

  return { sql, loading, error }
}

function migrationDisplayName(name: string): string {
  if (name.startsWith("initial_")) return "Initial schema sync"
  return name
}

function isInitialBaseline(m: Migration): boolean {
  return m.name.startsWith("initial_") && !m.has_sql
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

// ─── Author and renames ───────────────────────────────────────────────────────

/** Who pushed it, marked verified only when a control plane authenticated them. */
function AuthorCell({ migration }: { migration: MigrationAuthor }): React.ReactElement {
  if (migration.pushed_by === null) return <span className="text-muted-foreground/40">-</span>
  return (
    <span className="flex items-center gap-1.5">
      <span className="truncate max-w-[180px]" title={migration.pushed_by}>{migration.pushed_by}</span>
      <Badge variant={migration.pushed_by_verified === true ? "green" : "yellow"}>
        {migration.pushed_by_verified === true ? "verified" : "unverified"}
      </Badge>
    </span>
  )
}

function renameLabel(r: AppliedRename): string {
  return r.kind === "table" ? `table ${r.from} -> ${r.to}` : `${r.table}.${r.from} -> ${r.to}`
}

/** Each rename the migration applied, with who declared it and when. */
function RenameList({ renames }: { renames: AppliedRename[] }): React.ReactElement | null {
  if (renames.length === 0) return null
  return (
    <div className="space-y-1">
      {renames.map((r) => (
        <div key={renameLabel(r)} className="flex items-center gap-2 text-[0.7rem] font-mono text-muted-foreground">
          <Badge variant="yellow">renamed</Badge>
          <span>{renameLabel(r)}</span>
          {r.declared_by !== null && (
            <span>
              declared by {r.declared_by}
              {r.declared_at !== null && ` at ${new Date(r.declared_at).toLocaleString()}`}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** The audit trail of one migration: author, channel, origin and renames. */
/** One labelled line of a migration's details. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex justify-between text-[0.7rem] text-muted-foreground">
      <span>{label}</span>
      {children}
    </div>
  )
}

function AuditDetails({ migration }: { migration: Migration }): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <DetailRow label="Author">
        <AuthorCell migration={migration} />
      </DetailRow>
      <DetailRow label="Channel">
        <span className="font-mono">{migration.pushed_via ?? "-"}</span>
      </DetailRow>
      <DetailRow label="From">
        <span className="font-mono truncate max-w-[260px]" title={migration.pushed_from ?? ""}>{migration.pushed_from ?? "-"}</span>
      </DetailRow>
      <RenameList renames={migration.renames} />
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

// ─── Outcome of a push that did not apply ─────────────────────────────────────

/** "Nothing was applied", and the rest of what the history says about it. */
function nothingApplied(outcome: MigrationOutcome): string {
  const when = outcome.status === "refused" ? "Refused before it began" : "Failed while it applied"
  return `${when}. Nothing was applied${outcome.superseded ? "; a later push has applied since." : "."}`
}

/**
 * Why a push failed or was refused, and for a refused one what it would have dropped, how to apply
 * it and the statements it would have run. Nothing for a push that applied.
 */
function OutcomeDetails({ outcome }: { outcome: MigrationOutcome }): React.ReactElement | null {
  if (outcome.status !== "failed" && outcome.status !== "refused") return null
  const refusal = outcome.refusal
  return (
    <div className="space-y-2 mb-3 text-xs">
      <p className="text-muted-foreground">{nothingApplied(outcome)}</p>
      {outcome.error !== null && <p className="font-mono text-red-400">{withoutForceAdvice(outcome.error)}</p>}
      {refusal !== null && <RefusalOperations operations={refusal.operations} />}
      {refusal !== null && <RefusalHints hints={refusal.hints} />}
      {refusal !== null && refusal.sql !== null && <SqlBlock sql={refusal.sql} />}
    </div>
  )
}

// ─── Inline expanded row ──────────────────────────────────────────────────────

function ExpandedRow({ proxy, migration, changes, colSpan }: {
  proxy: ProjectProxy
  migration: Migration
  changes: ModelChange[]
  colSpan: number
}): React.ReactElement {
  const { sql, loading: sqlLoading, error: sqlError } = useMigrationSql(
    proxy,
    migration.id,
    migration.has_sql,
    true,
  )
  const hasSql = migration.has_sql
  const [tab, setTab] = useState<"changes" | "sql">(hasSql ? "sql" : "changes")
  const hasChanges = changes.length > 0
  const baseline = isInitialBaseline(migration)

  return (
    <tr className="bg-accent/20 border-b border-border">
      <td colSpan={colSpan} className="px-4 py-3">
        <OutcomeDetails outcome={migration.outcome} />
        {baseline && (
          <p className="text-xs text-muted-foreground mb-3">
            First push recorded the schema baseline. No database DDL was required.
          </p>
        )}
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
        {tab === "sql" && sqlLoading && (
          <p className="text-xs text-muted-foreground">Loading SQL…</p>
        )}
        {tab === "sql" && sqlError && (
          <p className="text-xs text-red-400">{sqlError}</p>
        )}
        {tab === "sql" && sql && <SqlBlock sql={sql} />}
        <div className="mt-3 pt-3 border-t border-border/50">
          <AuditDetails migration={migration} />
        </div>
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

function SlideOutPanel({ proxy, migration, changes, onClose }: {
  proxy: ProjectProxy
  migration: Migration
  changes: ModelChange[]
  onClose: () => void
}): React.ReactElement {
  const { sql, loading: sqlLoading, error: sqlError } = useMigrationSql(
    proxy,
    migration.id,
    migration.has_sql,
    true,
  )
  const hasSql = migration.has_sql
  const [tab, setTab] = useState<"changes" | "sql">(hasSql ? "sql" : "changes")
  const status = migration.outcome.status
  const baseline = isInitialBaseline(migration)
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
            <h3 className="text-sm font-semibold leading-snug break-all">{migrationDisplayName(migration.name)}</h3>
            {migration.name !== migrationDisplayName(migration.name) && (
              <p className="text-[0.65rem] text-muted-foreground font-mono mt-0.5">{migration.name}</p>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <Badge variant={MIGRATION_STATUS_VARIANT[status]}>{migrationStatusLabel(status)}</Badge>
              {baseline && <Badge variant="yellow">baseline</Badge>}
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
          <AuditDetails migration={migration} />
        </div>
        {!appliedSchema(migration) ? (
          <div className="px-5 pt-3 border-b border-border/40 flex-shrink-0">
            <OutcomeDetails outcome={migration.outcome} />
          </div>
        ) : null}

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
          {tab === "sql" && sqlLoading && (
            <p className="text-xs text-muted-foreground">Loading SQL…</p>
          )}
          {tab === "sql" && sqlError && (
            <p className="text-xs text-red-400">{sqlError}</p>
          )}
          {tab === "sql" && sql && <SqlBlock sql={sql} />}
        </div>
      </div>
    </>
  )
}

/** The migration a `?migration=<id>` link names, or null for anything that is not an id. */
export function linkedMigrationId(param: string | null): number | null {
  return param !== null && /^\d+$/.test(param) ? Number(param) : null
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function MigrationHistory(): React.ReactElement {
  const proxy = useProjectProxy()

  const { data: migrationsData, loading, error, failure, refetch } = useApiQuery(
    async () => {
      const columns = await proxy.metadata("migrations_audited")
      const audited = boolOrNull(columns.rows[0]?.["audited"]) === true
      const result = await proxy.metadata(migrationsQuery(audited))
      return result.rows.map(mapMigrationRow)
    },
    [proxy],
  )

  const migrations = migrationsData ?? []
  const trackedMigrations = useMemo(
    () => migrations.filter(isTrackedMigration),
    [migrations],
  )
  const visibleMigrations = useMemo(
    () => buildVisibleMigrations(trackedMigrations),
    [trackedMigrations],
  )
  const hiddenCount = migrations.length - visibleMigrations.length
  const displayMigrations = useMemo(() => [...visibleMigrations].reverse(), [visibleMigrations])

  const diffs = useMemo(() => changesByMigration(trackedMigrations), [trackedMigrations])

  // A link to one migration (from Schema objects): shown on its own, already expanded.
  const [params, setParams] = useSearchParams()
  const linkedId = linkedMigrationId(params.get("migration"))

  // Inline expanded row id
  const [expandedId, setExpandedId] = useState<number | null>(linkedId)
  // Following another link while this screen is open expands the migration it names.
  useEffect(() => {
    if (linkedId !== null) setExpandedId(linkedId)
  }, [linkedId])
  // Slide-out panel migration
  const [slideOut, setSlideOut] = useState<Migration | null>(null)

  const [search, setSearch] = useState("")
  const [filterStatus, setFilterStatus] = useState("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  const filtered = useMemo(() => {
    // From every tracked migration, not only the visible ones: the one a link names may be a
    // repeat sync this screen otherwise hides.
    if (linkedId !== null) return trackedMigrations.filter((m) => m.id === linkedId)
    return displayMigrations.filter((m) => {
      const status = m.outcome.status
      if (search && !m.name.toLowerCase().includes(search.toLowerCase()) && !String(m.id).includes(search)) return false
      if (filterStatus !== "all" && status !== filterStatus) return false
      if (dateFrom && new Date(m.applied_at) < new Date(dateFrom)) return false
      if (dateTo && new Date(m.applied_at) > new Date(dateTo + "T23:59:59Z")) return false
      return true
    })
  }, [linkedId, trackedMigrations, displayMigrations, search, filterStatus, dateFrom, dateTo])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-muted-foreground">Loading migrations...</span>
      </div>
    )
  }

  if (error) {
    if (failure !== null && isMissingTable(failure, MIGRATIONS_TABLE)) {
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

  if (visibleMigrations.length === 0) {
    return (
      <EmptyState
        title="No database migrations yet"
        description={
          migrations.length > 0
            ? "Repeated syncs with no schema change are hidden. Run `supatype push` after a schema change to record a new migration."
            : "Run `supatype push` to apply your schema and start tracking database migrations."
        }
        action={refetch}
        actionLabel="Refresh"
      />
    )
  }

  return (
    <>
      {linkedId !== null && (
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
          <span>
            {filtered.length === 0
              ? `Migration #${linkedId} not found.`
              : `Showing migration #${linkedId} only.`}
          </span>
          <Button size="xs" onClick={() => setParams({})}>Show all</Button>
        </div>
      )}

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
          {MIGRATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {migrationStatusLabel(status).replace(/^./, (first) => first.toUpperCase())}
            </option>
          ))}
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
              <Th>Author</Th>
              <Th>Engine</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const status = m.outcome.status
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
                    <Td className="font-medium">
                      <span title={m.name}>{migrationDisplayName(m.name)}</span>
                      {isInitialBaseline(m) && (
                        <Badge variant="yellow" className="ml-2 text-[0.6rem]">baseline</Badge>
                      )}
                    </Td>
                    <Td><Badge variant={MIGRATION_STATUS_VARIANT[status]}>{migrationStatusLabel(status)}</Badge></Td>
                    <Td><ChangeSummaryPills changes={changes} hasSnapshot={m.schema_snapshot !== null} /></Td>
                    <Td className="text-xs text-muted-foreground">{new Date(m.applied_at).toLocaleString()}</Td>
                    <Td className="text-xs"><AuthorCell migration={m} /></Td>
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
                    <ExpandedRow proxy={proxy} migration={m} changes={changes} colSpan={9} />
                  )}
                </React.Fragment>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center py-8 text-muted-foreground text-sm">
                  {linkedId !== null
                    ? `Migration #${linkedId} not found: no tracked schema migration has that id.`
                    : "No migrations match your filters"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="text-xs text-muted-foreground mt-2">
        {filtered.length} of {visibleMigrations.length} database migration{visibleMigrations.length === 1 ? "" : "s"} shown
        {hiddenCount > 0 && ` · ${hiddenCount} duplicate or metadata-only sync${hiddenCount === 1 ? "" : "s"} hidden`}
      </div>

      {/* Slide-out panel */}
      {slideOut && (
        <SlideOutPanel
          proxy={proxy}
          migration={slideOut}
          changes={diffs.get(slideOut.id) ?? []}
          onClose={() => setSlideOut(null)}
        />
      )}
    </>
  )
}
