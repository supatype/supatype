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

import React, { useState } from "react"
import { Link } from "react-router-dom"
import { Badge, Card, Input, Pager, Select, Td, Th, type BadgeVariant } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { containing, sqlText } from "../lib/sql.js"
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

/** One page of objects, how many match in all, and every kind the ledger holds (for the filter). */
export interface ObjectPage {
  objects: ManagedObject[]
  total: number
  kinds: string[]
}

export const NO_FILTERS: ObjectFilters = { kind: "all", table: "", status: "all" }

export const PAGE_SIZE = 50

export const KINDS_SQL = "SELECT DISTINCT kind FROM _supatype.managed_objects ORDER BY kind"

const statusVariant: Record<ObjectStatus, BadgeVariant> = {
  managed: "green",
  adopted: "blue",
  // Yellow: Supatype has stopped looking after it, which is worth a second glance.
  released: "yellow",
}

const STATUSES: readonly ObjectStatus[] = ["managed", "adopted", "released"]

// --- Reading the ledger ---

/** The page of `_supatype.managed_objects` that `query` asks for, with the count of all matches. */
export function objectsQuery({ filters, page }: ObjectQuery): string {
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
  return `SELECT kind, schema_name, parent, name, status, migration_id, updated_at::TEXT,
       count(*) OVER () AS total
 FROM _supatype.managed_objects${where.length > 0 ? `\n WHERE ${where.join(" AND ")}` : ""}
 ORDER BY kind, schema_name, parent, name
 LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`
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

/** The page the rows of `objectsQuery` make, given the ledger's kinds. */
export function toPage(rows: readonly Record<string, unknown>[], kinds: string[]): ObjectPage {
  return { objects: rows.map(mapObjectRow), total: Number(rows[0]?.["total"] ?? 0), kinds }
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

/** Fetching state, from `useApiQuery`. Loading is a null result: the first page has not arrived. */
export interface LoadState {
  error: string | null
  onRefresh: () => void
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
  return (
    <>
      <FilterBar filters={query.filters} kinds={result.kinds} onChange={(filters) => onQuery({ filters, page: 0 })} />
      <ObjectTable objects={result.objects} />
      <Pager
        at={{ page: query.page, pageSize: PAGE_SIZE, total: result.total }}
        onPage={(page) => onQuery({ ...query, page })}
      />
    </>
  )
}

export function SchemaObjects(): React.ReactElement {
  const proxy = useProjectProxy()
  const [query, setQuery] = useState<ObjectQuery>({ filters: NO_FILTERS, page: 0 })

  const { data, error, refetch } = useApiQuery(async () => {
    const [rows, kinds] = await Promise.all([proxy.sql(objectsQuery(query)), proxy.sql(KINDS_SQL)])
    return toPage(rows.rows, kinds.rows.map((r) => String(r["kind"] ?? "")))
  }, [proxy, query])

  return (
    <SchemaObjectsView
      result={data}
      query={query}
      onQuery={setQuery}
      load={{ error, onRefresh: refetch }}
    />
  )
}
