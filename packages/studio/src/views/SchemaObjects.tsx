/**
 * Every object Supatype owns in this environment, from the managed-object ledger.
 *
 * `_supatype.managed_objects` is what a push decides ownership by (managed-object ownership plan,
 * section 8). Built like `SeedHistory.tsx`: the same primitives, the same `proxy.sql` read, and
 * no new engine endpoint. Each row links to the migration that last changed it.
 *
 * The ledger holds a row per column and per grant, so it is read a page at a time, filtered in the
 * query rather than in the browser. Released objects are shown, not hidden: an object every push
 * now leaves alone is the one an operator most needs to remember exists.
 */

import React, { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Badge, Card, Input, Pager, Select, Td, Th, type BadgeVariant } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { formatTimestamp } from "../lib/utils.js"

// --- Types ---

export type ObjectStatus = "managed" | "adopted" | "released"

export interface ManagedObject {
  kind: string
  schema: string
  /** The table for table-scoped kinds; empty for a table, a schema, a function and the like. */
  parent: string
  name: string
  status: ObjectStatus
  /** The migration that last changed it, or null until a push has. */
  migration_id: number | null
  updated_at: string
}

export interface ObjectFilters {
  kind: string
  table: string
  status: "all" | ObjectStatus
}

/** What is being looked at: the filters and the zero-based page. */
export interface ObjectQuery {
  filters: ObjectFilters
  page: number
}

/**
 * One page of objects, which page it is, how many match in all, and every kind the ledger holds
 * (for the filter). The page travels with its rows so the pager always names the rows on screen.
 */
export interface ObjectPage {
  objects: ManagedObject[]
  page: number
  total: number
  kinds: string[]
}

export const NO_FILTERS: ObjectFilters = { kind: "all", table: "", status: "all" }

export const PAGE_SIZE = 50

/** How long typing in the table filter waits before it asks the database. */
export const FILTER_DEBOUNCE_MS = 300

export const KINDS_SQL = "SELECT DISTINCT kind FROM _supatype.managed_objects ORDER BY kind"

const statusVariant: Record<ObjectStatus, BadgeVariant> = {
  managed: "green",
  adopted: "blue",
  // Yellow: Supatype has stopped looking after it, which is worth a second glance.
  released: "yellow",
}

const STATUSES: readonly ObjectStatus[] = ["managed", "adopted", "released"]

// --- Reading the ledger ---

/** A Postgres string literal. `proxy.sql` takes no parameters, so what the user types is quoted. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** `value` matched anywhere, with LIKE's own wildcards taken literally. */
function containing(value: string): string {
  return sqlText(`%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
}

/** The `WHERE` clause the filters make, or an empty string for none. */
function whereClause(filters: ObjectFilters): string {
  const where: string[] = []
  if (filters.kind !== "all") where.push(`kind = ${sqlText(filters.kind)}`)
  if (filters.status !== "all") where.push(`status = ${sqlText(filters.status)}`)
  const table = filters.table.trim()
  // A table's own row names it; anything else names it first in its parent (`table.column`).
  if (table !== "") {
    where.push(
      `(CASE WHEN parent = '' THEN name ELSE split_part(parent, '.', 1) END) ILIKE ${containing(table)} ESCAPE '\\'`,
    )
  }
  return where.length > 0 ? `\n WHERE ${where.join(" AND ")}` : ""
}

/** The page of `_supatype.managed_objects` that `query` asks for, with the count of all matches. */
export function objectsQuery({ filters, page }: ObjectQuery): string {
  return `SELECT kind, schema_name, parent, name, status, migration_id, updated_at::TEXT,
       count(*) OVER () AS total
 FROM _supatype.managed_objects${whereClause(filters)}
 ORDER BY kind, schema_name, parent, name
 LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`
}

/** How many objects match the filters, for a page past the end, which carries no count. */
export function objectsCountQuery(filters: ObjectFilters): string {
  return `SELECT count(*) AS total FROM _supatype.managed_objects${whereClause(filters)}`
}

/** The last zero-based page `total` objects fill (page 0 when there are none). */
export function lastPage(total: number): number {
  return Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)
}

/** One row of `_supatype.managed_objects`, which arrives as whatever the proxy decoded. */
export function mapObjectRow(row: Record<string, unknown>): ManagedObject {
  const migration = row["migration_id"]
  return {
    kind: String(row["kind"] ?? ""),
    schema: String(row["schema_name"] ?? ""),
    parent: String(row["parent"] ?? ""),
    name: String(row["name"] ?? ""),
    status: STATUSES.find((s) => s === row["status"]) ?? "managed",
    migration_id: migration === null || migration === undefined ? null : Number(migration),
    updated_at: String(row["updated_at"] ?? ""),
  }
}

/** The page the rows of `objectsQuery` make, given the ledger's kinds and which page they are. */
export function toPage(rows: readonly Record<string, unknown>[], kinds: string[], page = 0): ObjectPage {
  return { objects: rows.map(mapObjectRow), page, total: Number(rows[0]?.["total"] ?? 0), kinds }
}

/** What `fetchObjectPage` needs of the project proxy. */
export interface SqlRunner {
  sql: (query: string) => Promise<{ rows: Record<string, unknown>[] }>
}

/**
 * The page `query` asks for. A page past the end (objects removed since it was shown, so page 3 of
 * what is now 1) comes back as the last page there is, rather than an empty "Page 3 of 1 (0)".
 */
export async function fetchObjectPage(proxy: SqlRunner, query: ObjectQuery): Promise<ObjectPage> {
  const [rows, kindRows] = await Promise.all([proxy.sql(objectsQuery(query)), proxy.sql(KINDS_SQL)])
  const kinds = kindRows.rows.map((r) => String(r["kind"] ?? ""))
  const page = toPage(rows.rows, kinds, query.page)
  if (page.objects.length > 0 || query.page === 0) return page
  const count = await proxy.sql(objectsCountQuery(query.filters))
  const last = lastPage(Number(count.rows[0]?.["total"] ?? 0))
  if (last >= query.page) return page
  const again = await proxy.sql(objectsQuery({ ...query, page: last }))
  return toPage(again.rows, kinds, last)
}

/** `value`, once it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** `posts.posts_title_idx`, or `posts` for a table-level object. */
export function objectLabel(object: ManagedObject): string {
  return object.parent === "" ? object.name : `${object.parent}.${object.name}`
}

/** Where Migration History shows one migration on its own. */
export function migrationLink(id: number): string {
  return `/database/migrations?migration=${id}`
}

// --- The screen ---

interface FilterBarProps {
  filters: ObjectFilters
  kinds: readonly string[]
  onChange: (filters: ObjectFilters) => void
}

function FilterBar({ filters, kinds, onChange }: FilterBarProps): React.ReactElement {
  return (
    <div className="flex gap-2 mb-4 flex-wrap">
      <Input
        className="w-[240px]"
        placeholder="Filter by table..."
        value={filters.table}
        onChange={(e) => onChange({ ...filters, table: e.target.value })}
      />
      <Select className="w-[180px]" value={filters.kind} onChange={(e) => onChange({ ...filters, kind: e.target.value })}>
        <option value="all">All kinds</option>
        {kinds.map((kind) => (
          <option key={kind} value={kind}>{kind.replace(/_/g, " ")}</option>
        ))}
      </Select>
      <Select
        className="w-[140px]"
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: STATUSES.find((s) => s === e.target.value) ?? "all" })}
      >
        <option value="all">All status</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>{status}</option>
        ))}
      </Select>
    </div>
  )
}

function ObjectRow({ object }: { object: ManagedObject }): React.ReactElement {
  return (
    <tr className="border-b border-border hover:bg-accent/50">
      <Td className="text-xs text-muted-foreground">{object.kind.replace(/_/g, " ")}</Td>
      <Td className="font-mono text-xs">{objectLabel(object)}</Td>
      <Td className="text-xs text-muted-foreground">{object.schema}</Td>
      <Td><Badge variant={statusVariant[object.status]}>{object.status}</Badge></Td>
      <Td className="text-xs">
        {object.migration_id === null ? (
          // Named rather than blank: an adopted object has no migration until a push changes it.
          <span className="text-muted-foreground">not yet pushed</span>
        ) : (
          <Link to={migrationLink(object.migration_id)} className="text-primary hover:underline">
            #{object.migration_id}
          </Link>
        )}
      </Td>
      <Td className="text-xs text-muted-foreground">{formatTimestamp(object.updated_at)}</Td>
    </tr>
  )
}

function ObjectTable({ objects }: { objects: readonly ManagedObject[] }): React.ReactElement {
  return (
    <Card className="overflow-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <Th>Kind</Th>
            <Th>Object</Th>
            <Th>Schema</Th>
            <Th>Status</Th>
            <Th>Last changed by</Th>
            <Th>Updated at</Th>
          </tr>
        </thead>
        <tbody>
          {objects.map((o) => (
            <ObjectRow key={`${o.kind}:${o.schema}:${o.parent}:${o.name}`} object={o} />
          ))}
          {objects.length === 0 && (
            <tr>
              <td colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                No objects match your filters
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}

/**
 * Fetching state, from `useApiQuery`. A null result is the first page not having arrived; `loading`
 * with a result is the next page on its way, while the last one stays on screen.
 */
export interface LoadState {
  error: string | null
  onRefresh: () => void
  loading?: boolean
}

export interface SchemaObjectsViewProps {
  result: ObjectPage | null
  query: ObjectQuery
  onQuery: (query: ObjectQuery) => void
  load: LoadState
}

/**
 * Everything the screen shows, given what it shows it. Separated from the fetching so every state
 * it can be in is one a test can render. A page already shown stays while the next one loads, so
 * typing in the filter does not blank the screen.
 */
export function SchemaObjectsView({ result, query, onQuery, load }: SchemaObjectsViewProps): React.ReactElement {
  // The ledger is created by the first push of an engine that has it, so its absence means this
  // database has not had one yet rather than anything being broken.
  const missing = load.error !== null && load.error.includes("does not exist")
  if (load.error !== null && !missing) {
    return <ErrorBanner message={load.error} onRetry={load.onRefresh} />
  }
  if (result === null && !missing) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-muted-foreground">Loading schema objects...</span>
      </div>
    )
  }
  if (missing || result === null || result.kinds.length === 0) {
    return (
      <EmptyState
        title="No schema objects recorded yet"
        description="Run `supatype push` to apply your schema. Every object it creates or adopts is recorded here."
        action={load.onRefresh}
        actionLabel="Refresh"
      />
    )
  }
  const loading = load.loading === true
  return (
    <>
      <FilterBar filters={query.filters} kinds={result.kinds} onChange={(filters) => onQuery({ filters, page: 0 })} />
      <div className={loading ? "opacity-60 transition-opacity" : undefined} aria-busy={loading}>
        <ObjectTable objects={result.objects} />
      </div>
      {/* The page of the rows on screen, not the one being asked for: they differ while it loads. */}
      <Pager
        at={{ page: result.page, pageSize: PAGE_SIZE, total: result.total }}
        onPage={(page) => onQuery({ ...query, page })}
        busy={loading}
      />
    </>
  )
}

export function SchemaObjects(): React.ReactElement {
  const proxy = useProjectProxy()
  const [query, setQuery] = useState<ObjectQuery>({ filters: NO_FILTERS, page: 0 })
  // The filter box shows every keystroke; the database is asked once typing pauses.
  const table = useDebouncedValue(query.filters.table, FILTER_DEBOUNCE_MS)
  const { page, filters: { kind, status } } = query
  const asked = useMemo<ObjectQuery>(
    () => ({ filters: { kind, status, table }, page }),
    [kind, status, table, page],
  )

  const { data, loading, error, refetch } = useApiQuery(() => fetchObjectPage(proxy, asked), [proxy, asked])

  return (
    <SchemaObjectsView
      result={data}
      query={query}
      onQuery={setQuery}
      load={{ error, onRefresh: refetch, loading }}
    />
  )
}
