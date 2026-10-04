/**
 * Every object Supatype owns in this environment, from the managed-object ledger.
 *
 * `_supatype.managed_objects` is what a push decides ownership by (managed-object ownership plan,
 * section 8). Built like `SeedHistory.tsx`: the same primitives, the same `proxy.sql` read, and
 * no new engine endpoint. Each row links to the migration that last changed it.
 *
 * Released objects are shown, not hidden: an object every push now leaves alone is the one an
 * operator most needs to remember exists.
 */

import React, { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Badge, Card, Input, Select, Td, Th, type BadgeVariant } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"

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

export const NO_FILTERS: ObjectFilters = { kind: "all", table: "", status: "all" }

export const MANAGED_OBJECTS_SQL = `SELECT kind, schema_name, parent, name, status, migration_id,
       updated_at::TEXT
 FROM _supatype.managed_objects ORDER BY kind, schema_name, parent, name`

const statusVariant: Record<ObjectStatus, BadgeVariant> = {
  managed: "green",
  adopted: "blue",
  // Yellow: Supatype has stopped looking after it, which is worth a second glance.
  released: "yellow",
}

const STATUSES: readonly ObjectStatus[] = ["managed", "adopted", "released"]

// --- Reading the ledger ---

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

/** `posts.posts_title_idx`, or `posts` for a table-level object. */
export function objectLabel(object: ManagedObject): string {
  return object.parent === "" ? object.name : `${object.parent}.${object.name}`
}

/** The table an object belongs to: its parent, or itself for a table. */
function tableOf(object: ManagedObject): string {
  return object.parent === "" ? object.name : (object.parent.split(".")[0] ?? object.parent)
}

/** The objects `filters` lets through. The table filter matches part of a table's name. */
export function filterObjects(
  objects: readonly ManagedObject[],
  filters: ObjectFilters,
): ManagedObject[] {
  const table = filters.table.trim().toLowerCase()
  return objects.filter(
    (o) =>
      (filters.kind === "all" || o.kind === filters.kind) &&
      (filters.status === "all" || o.status === filters.status) &&
      (table === "" || tableOf(o).toLowerCase().includes(table)),
  )
}

/** Where Migration History shows one migration on its own. */
export function migrationLink(id: number): string {
  return `/database/migrations?migration=${id}`
}

// --- The screen ---

export interface SchemaObjectsViewProps {
  objects: ManagedObject[] | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}

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
      <Td className="text-xs text-muted-foreground">{object.updated_at}</Td>
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

function FilteredObjects({ objects }: { objects: readonly ManagedObject[] }): React.ReactElement {
  const [filters, setFilters] = useState<ObjectFilters>(NO_FILTERS)
  const kinds = useMemo(() => [...new Set(objects.map((o) => o.kind))].sort(), [objects])
  const shown = useMemo(() => filterObjects(objects, filters), [objects, filters])
  return (
    <>
      <FilterBar filters={filters} kinds={kinds} onChange={setFilters} />
      <ObjectTable objects={shown} />
      <div className="text-xs text-muted-foreground mt-2">
        {shown.length} of {objects.length} object{objects.length === 1 ? "" : "s"} shown
      </div>
    </>
  )
}

/**
 * Everything the screen shows, given what it shows it. Separated from the fetching so every state
 * it can be in is one a test can render.
 */
export function SchemaObjectsView({
  objects,
  loading,
  error,
  onRefresh,
}: SchemaObjectsViewProps): React.ReactElement {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-muted-foreground">Loading schema objects...</span>
      </div>
    )
  }

  // The ledger is created by the first push of an engine that has it, so its absence means this
  // database has not had one yet rather than anything being broken.
  if (error !== null && !error.includes("does not exist")) {
    return <ErrorBanner message={error} onRetry={onRefresh} />
  }

  const rows = error !== null ? [] : (objects ?? [])
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No schema objects recorded yet"
        description="Run `supatype push` to apply your schema. Every object it creates or adopts is recorded here."
        action={onRefresh}
        actionLabel="Refresh"
      />
    )
  }

  return <FilteredObjects objects={rows} />
}

export function SchemaObjects(): React.ReactElement {
  const proxy = useProjectProxy()

  const { data, loading, error, refetch } = useApiQuery(async () => {
    const result = await proxy.sql(MANAGED_OBJECTS_SQL)
    return result.rows.map(mapObjectRow)
  }, [proxy])

  return (
    <SchemaObjectsView objects={data} loading={loading} error={error} onRefresh={refetch} />
  )
}
