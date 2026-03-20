import React, { useState, useCallback, useEffect, useMemo, useRef } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface TableInfo {
  name: string
  schema: string
  row_count: number
  columns: ColumnInfo[]
}

interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  is_primary: boolean
  is_foreign_key: boolean
  references: string | null
  default_value: string | null
  enum_values: string[] | null
}

interface ColumnFilter {
  column: string
  operator: FilterOperator
  value: string
}

type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is_null" | "is_not_null" | "in"

interface SortSpec {
  column: string
  ascending: boolean
}

interface BulkAction {
  type: "delete"
  ids: string[]
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockTables: TableInfo[] = [
  {
    name: "users",
    schema: "public",
    row_count: 42,
    columns: [
      { name: "id", type: "uuid", nullable: false, is_primary: true, is_foreign_key: false, references: null, default_value: "gen_random_uuid()", enum_values: null },
      { name: "email", type: "text", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "name", type: "text", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "avatar_url", type: "text", nullable: true, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "created_at", type: "timestamptz", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: "now()", enum_values: null },
    ],
  },
  {
    name: "posts",
    schema: "public",
    row_count: 156,
    columns: [
      { name: "id", type: "uuid", nullable: false, is_primary: true, is_foreign_key: false, references: null, default_value: "gen_random_uuid()", enum_values: null },
      { name: "title", type: "text", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "slug", type: "text", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "content", type: "text", nullable: true, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "author_id", type: "uuid", nullable: false, is_primary: false, is_foreign_key: true, references: "users.id", default_value: null, enum_values: null },
      { name: "status", type: "text", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: "'draft'", enum_values: ["draft", "published", "archived"] },
      { name: "metadata", type: "jsonb", nullable: true, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "created_at", type: "timestamptz", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: "now()", enum_values: null },
      { name: "updated_at", type: "timestamptz", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: "now()", enum_values: null },
    ],
  },
  {
    name: "tags",
    schema: "public",
    row_count: 12,
    columns: [
      { name: "id", type: "uuid", nullable: false, is_primary: true, is_foreign_key: false, references: null, default_value: "gen_random_uuid()", enum_values: null },
      { name: "name", type: "text", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
      { name: "slug", type: "text", nullable: false, is_primary: false, is_foreign_key: false, references: null, default_value: null, enum_values: null },
    ],
  },
  {
    name: "post_tags",
    schema: "public",
    row_count: 89,
    columns: [
      { name: "post_id", type: "uuid", nullable: false, is_primary: true, is_foreign_key: true, references: "posts.id", default_value: null, enum_values: null },
      { name: "tag_id", type: "uuid", nullable: false, is_primary: true, is_foreign_key: true, references: "tags.id", default_value: null, enum_values: null },
    ],
  },
]

const mockRows: Record<string, unknown>[] = [
  { id: "a1b2c3d4", email: "alice@example.com", name: "Alice", avatar_url: "https://i.pravatar.cc/40?u=alice", created_at: "2026-01-15T10:30:00Z" },
  { id: "d4e5f6g7", email: "bob@example.com", name: "Bob", avatar_url: null, created_at: "2026-02-01T14:20:00Z" },
  { id: "g7h8i9j0", email: "carol@example.com", name: "Carol", avatar_url: "https://i.pravatar.cc/40?u=carol", created_at: "2026-02-14T09:15:00Z" },
  { id: "j0k1l2m3", email: "dave@example.com", name: "Dave", avatar_url: null, created_at: "2026-03-01T16:45:00Z" },
  { id: "m3n4o5p6", email: "eve@example.com", name: "Eve", avatar_url: "https://i.pravatar.cc/40?u=eve", created_at: "2026-03-10T11:00:00Z" },
]

const FILTER_OPERATORS: Array<{ value: FilterOperator; label: string }> = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: ">= " },
  { value: "lt", label: "less than" },
  { value: "lte", label: "<=" },
  { value: "like", label: "contains" },
  { value: "ilike", label: "contains (case-insensitive)" },
  { value: "is_null", label: "is null" },
  { value: "is_not_null", label: "is not null" },
  { value: "in", label: "in (comma-separated)" },
]

const PAGE_SIZES = [10, 25, 50, 100]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isImageUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  return /\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(value) || value.startsWith("https://i.pravatar.cc")
}

function isJsonValue(value: unknown): boolean {
  return typeof value === "object" && value !== null
}

// ─── JSON Tree Component ──────────────────────────────────────────────────────

function JsonTreeNode({ data, depth = 0 }: { data: unknown; depth?: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(depth < 2)

  if (data === null) return <span className="text-zinc-500 italic">null</span>
  if (typeof data === "boolean") return <span className="text-orange-400">{String(data)}</span>
  if (typeof data === "number") return <span className="text-blue-400">{data}</span>
  if (typeof data === "string") return <span className="text-green-400">&quot;{data}&quot;</span>

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-zinc-500">[]</span>
    return (
      <span>
        <button
          className="text-zinc-500 hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "[-]" : `[${data.length} items]`}
        </button>
        {expanded ? (
          <div className="ml-4">
            {data.map((item, i) => (
              <div key={i} className="flex gap-1">
                <span className="text-zinc-600">{i}:</span>
                <JsonTreeNode data={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        ) : null}
      </span>
    )
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>)
    if (entries.length === 0) return <span className="text-zinc-500">{"{}"}</span>
    return (
      <span>
        <button
          className="text-zinc-500 hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "{-}" : `{${entries.length} keys}`}
        </button>
        {expanded ? (
          <div className="ml-4">
            {entries.map(([key, val]) => (
              <div key={key} className="flex gap-1">
                <span className="text-purple-400">{key}:</span>
                <JsonTreeNode data={val} depth={depth + 1} />
              </div>
            ))}
          </div>
        ) : null}
      </span>
    )
  }

  return <span>{String(data)}</span>
}

// ─── Column Filter Row ────────────────────────────────────────────────────────

function ColumnFilterRow({
  columns,
  filter,
  onChange,
  onRemove,
}: {
  columns: ColumnInfo[]
  filter: ColumnFilter
  onChange: (f: ColumnFilter) => void
  onRemove: () => void
}): React.ReactElement {
  const needsValue = filter.operator !== "is_null" && filter.operator !== "is_not_null"
  return (
    <div className="flex gap-2 items-center">
      <Select
        className="w-[140px]"
        value={filter.column}
        onChange={(e) => onChange({ ...filter, column: e.target.value })}
      >
        {columns.map((c) => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </Select>
      <Select
        className="w-[170px]"
        value={filter.operator}
        onChange={(e) => onChange({ ...filter, operator: e.target.value as FilterOperator })}
      >
        {FILTER_OPERATORS.map((op) => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </Select>
      {needsValue ? (
        <Input
          className="w-[180px]"
          placeholder="Value..."
          value={filter.value}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
        />
      ) : null}
      <Button size="xs" onClick={onRemove}>Remove</Button>
    </div>
  )
}

// ─── New Record Form ──────────────────────────────────────────────────────────

function NewRecordForm({
  table,
  onSave,
  onCancel,
}: {
  table: TableInfo
  onSave: (record: Record<string, unknown>) => void
  onCancel: () => void
}): React.ReactElement {
  const editableColumns = table.columns.filter((c) => !c.default_value || !c.is_primary)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const col of editableColumns) {
      initial[col.name] = ""
    }
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleSave = () => {
    const newErrors: Record<string, string> = {}
    for (const col of editableColumns) {
      if (!col.nullable && !col.default_value && !values[col.name]?.trim()) {
        newErrors[col.name] = "Required"
      }
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    const record: Record<string, unknown> = {}
    for (const col of editableColumns) {
      const val = values[col.name]
      if (val === "" && col.nullable) {
        record[col.name] = null
      } else if (col.type === "jsonb" || col.type === "json") {
        try {
          record[col.name] = JSON.parse(val ?? "")
        } catch {
          record[col.name] = val
        }
      } else {
        record[col.name] = val
      }
    }
    onSave(record)
  }

  return (
    <Card className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="m-0">Insert new row into {table.name}</h3>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
      <div className="grid grid-cols-1 gap-3 max-w-[600px]">
        {editableColumns.map((col) => (
          <div key={col.name}>
            <label className="flex items-center gap-2 text-[0.8rem] text-muted-foreground mb-1">
              {col.name}
              <code className="text-[0.65rem] text-zinc-600">{col.type}</code>
              {!col.nullable && !col.default_value ? <span className="text-red-400">*</span> : null}
            </label>
            {col.enum_values ? (
              <Select
                className="w-full"
                value={values[col.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
              >
                <option value="">-- select --</option>
                {col.enum_values.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </Select>
            ) : col.type === "boolean" ? (
              <Select
                className="w-full"
                value={values[col.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
              >
                <option value="">-- select --</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </Select>
            ) : col.type === "jsonb" || col.type === "json" ? (
              <textarea
                className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm font-mono focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 min-h-[80px] resize-y"
                placeholder="{}"
                value={values[col.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
              />
            ) : (
              <Input
                value={values[col.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [col.name]: e.target.value }))}
                placeholder={col.default_value ? `Default: ${col.default_value}` : undefined}
              />
            )}
            {errors[col.name] ? (
              <span className="text-red-400 text-xs">{errors[col.name]}</span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-4">
        <Button variant="primary" onClick={handleSave}>Insert Row</Button>
      </div>
    </Card>
  )
}

// ─── Delete Confirmation Dialog ───────────────────────────────────────────────

function DeleteConfirmation({
  count,
  onConfirm,
  onCancel,
}: {
  count: number
  onConfirm: () => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="p-6 max-w-[400px]">
        <h3 className="text-red-400 m-0 mb-2">Confirm Delete</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Are you sure you want to delete {count} {count === 1 ? "record" : "records"}?
          This action cannot be undone.
        </p>
        <div className="flex gap-2 justify-end">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Delete {count} {count === 1 ? "record" : "records"}</Button>
        </div>
      </Card>
    </div>
  )
}

// ─── Cell Renderer ────────────────────────────────────────────────────────────

function CellValue({
  value,
  column,
  onRelationClick,
}: {
  value: unknown
  column: ColumnInfo
  onRelationClick?: (table: string, id: string) => void
}): React.ReactElement {
  if (value === null || value === undefined) {
    return <span className="text-zinc-600 italic">NULL</span>
  }

  // Image thumbnail
  if (isImageUrl(value)) {
    return (
      <div className="flex items-center gap-2">
        <img
          src={String(value)}
          alt=""
          className="w-8 h-8 rounded object-cover border border-border"
          loading="lazy"
        />
        <span className="text-[0.75rem] text-muted-foreground truncate max-w-[120px]">{String(value)}</span>
      </div>
    )
  }

  // Foreign key relation link
  if (column.is_foreign_key && column.references && typeof value === "string") {
    const [refTable] = column.references.split(".")
    return (
      <button
        className="text-primary hover:underline text-[0.8rem] font-mono"
        onClick={() => onRelationClick?.(refTable!, String(value))}
        title={`View in ${refTable}`}
      >
        {String(value).slice(0, 8)}...
      </button>
    )
  }

  // Enum dropdown display
  if (column.enum_values) {
    const colorMap: Record<string, string> = {
      draft: "yellow",
      published: "green",
      archived: "red",
    }
    const variant = (colorMap[String(value)] ?? "blue") as "green" | "yellow" | "red" | "blue"
    return <Badge variant={variant}>{String(value)}</Badge>
  }

  // JSON tree
  if (isJsonValue(value)) {
    return (
      <div className="font-mono text-[0.7rem]">
        <JsonTreeNode data={value} />
      </div>
    )
  }

  // Date formatting
  if (column.type === "timestamptz" || column.type === "timestamp") {
    return <span className="text-[0.8rem] text-muted-foreground">{new Date(String(value)).toLocaleString()}</span>
  }

  return <span className="text-[0.8rem]">{String(value)}</span>
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function DataExplorer(): React.ReactElement {
  const client = useStudioClient()

  // Table list state
  const [tables] = useState<TableInfo[]>(mockTables)
  const [tableSearch, setTableSearch] = useState("")
  const [selectedTable, setSelectedTable] = useState<string>(mockTables[0]?.name ?? "")

  // Row data state
  const [rows, setRows] = useState<Record<string, unknown>[]>(mockRows)
  const [totalCount, setTotalCount] = useState(mockRows.length)
  const [loading, setLoading] = useState(false)

  // Pagination
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)

  // Sorting (supports multi-column via shift-click)
  const [sorts, setSorts] = useState<SortSpec[]>([])

  // Filtering
  const [filters, setFilters] = useState<ColumnFilter[]>([])
  const [showFilters, setShowFilters] = useState(false)

  // Inline editing
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; col: string } | null>(null)
  const [editValue, setEditValue] = useState("")

  // View mode
  const [viewMode, setViewMode] = useState<"table" | "json">("table")

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // New record form
  const [showNewRecord, setShowNewRecord] = useState(false)

  // Record inspector
  const [inspectedRow, setInspectedRow] = useState<Record<string, unknown> | null>(null)

  // Current table info
  const currentTable = useMemo(() => tables.find((t) => t.name === selectedTable), [tables, selectedTable])
  const columns = currentTable?.columns ?? []

  // Filtered tables
  const filteredTables = tableSearch
    ? tables.filter((t) => t.name.toLowerCase().includes(tableSearch.toLowerCase()))
    : tables

  // Client-side sort (mock — in production, server-side via PostgREST order param)
  const sortedRows = useMemo(() => {
    if (sorts.length === 0) return rows
    return [...rows].sort((a, b) => {
      for (const sort of sorts) {
        const va = String(a[sort.column] ?? "")
        const vb = String(b[sort.column] ?? "")
        const cmp = va.localeCompare(vb)
        if (cmp !== 0) return sort.ascending ? cmp : -cmp
      }
      return 0
    })
  }, [rows, sorts])

  // Client-side filter (mock — in production, server-side via PostgREST filters)
  const filteredRows = useMemo(() => {
    if (filters.length === 0) return sortedRows
    return sortedRows.filter((row) => {
      return filters.every((f) => {
        const val = row[f.column]
        const strVal = String(val ?? "").toLowerCase()
        switch (f.operator) {
          case "eq": return strVal === f.value.toLowerCase()
          case "neq": return strVal !== f.value.toLowerCase()
          case "gt": return strVal > f.value.toLowerCase()
          case "gte": return strVal >= f.value.toLowerCase()
          case "lt": return strVal < f.value.toLowerCase()
          case "lte": return strVal <= f.value.toLowerCase()
          case "like": return strVal.includes(f.value.toLowerCase())
          case "ilike": return strVal.includes(f.value.toLowerCase())
          case "is_null": return val === null || val === undefined
          case "is_not_null": return val !== null && val !== undefined
          case "in": return f.value.split(",").map((s) => s.trim().toLowerCase()).includes(strVal)
          default: return true
        }
      })
    })
  }, [sortedRows, filters])

  // Pagination
  const pagedRows = filteredRows.slice(page * pageSize, (page + 1) * pageSize)
  const totalPages = Math.ceil(filteredRows.length / pageSize)

  // Primary key column name
  const pkColumn = columns.find((c) => c.is_primary)?.name ?? "id"

  // Sort handler — shift-click for multi-column
  const handleSort = useCallback((col: string, shiftKey: boolean) => {
    setSorts((prev) => {
      const existing = prev.findIndex((s) => s.column === col)
      if (existing >= 0) {
        // Toggle direction or remove
        const current = prev[existing]!
        if (!current.ascending) {
          // Remove this sort
          return [...prev.slice(0, existing), ...prev.slice(existing + 1)]
        }
        return [...prev.slice(0, existing), { column: col, ascending: false }, ...prev.slice(existing + 1)]
      }
      if (shiftKey) {
        return [...prev, { column: col, ascending: true }]
      }
      return [{ column: col, ascending: true }]
    })
  }, [])

  // Cell editing
  const handleCellEdit = (rowIdx: number, col: string) => {
    const row = pagedRows[rowIdx]
    if (!row) return
    setEditingCell({ rowIdx, col })
    setEditValue(String(row[col] ?? ""))
  }

  const handleCellSave = () => {
    if (!editingCell) return
    const row = pagedRows[editingCell.rowIdx]
    if (!row) { setEditingCell(null); return }
    // In production: PATCH to PostgREST
    const newRows = rows.map((r) => {
      if (r[pkColumn] === row[pkColumn]) {
        return { ...r, [editingCell.col]: editValue === "NULL" ? null : editValue }
      }
      return r
    })
    setRows(newRows)
    setEditingCell(null)
  }

  // Bulk selection
  const toggleSelectAll = () => {
    if (selectedIds.size === pagedRows.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(pagedRows.map((r) => String(r[pkColumn]))))
    }
  }

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkDelete = () => {
    setRows((prev) => prev.filter((r) => !selectedIds.has(String(r[pkColumn]))))
    setSelectedIds(new Set())
    setShowDeleteConfirm(false)
  }

  // Single row delete
  const handleDeleteRow = (id: string) => {
    setRows((prev) => prev.filter((r) => String(r[pkColumn]) !== id))
  }

  // New record
  const handleNewRecord = (record: Record<string, unknown>) => {
    setRows((prev) => [...prev, { [pkColumn]: `new-${Date.now()}`, ...record }])
    setShowNewRecord(false)
  }

  // Relation navigation
  const handleRelationClick = (table: string, id: string) => {
    setSelectedTable(table)
    setPage(0)
    setFilters([{ column: "id", operator: "eq", value: id }])
    setShowFilters(true)
  }

  // Table selection handler
  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName)
    setPage(0)
    setSorts([])
    setFilters([])
    setSelectedIds(new Set())
    setInspectedRow(null)
    setEditingCell(null)
    setShowNewRecord(false)
    // In production: fetch rows from PostgREST
  }

  // Sort indicator
  const getSortIndicator = (col: string): string => {
    const sort = sorts.find((s) => s.column === col)
    if (!sort) return ""
    const idx = sorts.indexOf(sort)
    const arrow = sort.ascending ? "\u2191" : "\u2193"
    return sorts.length > 1 ? `${arrow}${idx + 1}` : arrow
  }

  return (
    <div className="flex gap-4 h-full">
      {/* Table selector sidebar */}
      <div className="w-[220px] flex-shrink-0">
        <Input
          placeholder="Search tables..."
          value={tableSearch}
          onChange={(e) => setTableSearch(e.target.value)}
          className="mb-2"
        />
        <Card className="p-1.5 flex flex-col gap-0.5 max-h-[calc(100vh-200px)] overflow-y-auto">
          {filteredTables.map((t) => (
            <button
              key={t.name}
              className={cn(
                "flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors",
                t.name === selectedTable && "bg-accent text-foreground font-medium"
              )}
              onClick={() => handleSelectTable(t.name)}
            >
              <span className="truncate">{t.name}</span>
              <span className="ml-auto text-zinc-600 text-[0.7rem] flex-shrink-0">{t.row_count}</span>
            </button>
          ))}
        </Card>
      </div>

      {/* Main data area */}
      <div className="flex-1 min-w-0">
        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <Button
            variant={viewMode === "table" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setViewMode("table")}
          >
            Table
          </Button>
          <Button
            variant={viewMode === "json" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setViewMode("json")}
          >
            JSON
          </Button>

          <div className="flex-1" />

          <Button
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
          >
            Filters {filters.length > 0 ? `(${filters.length})` : ""}
          </Button>

          {selectedIds.size > 0 ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete {selectedIds.size} selected
            </Button>
          ) : null}

          <Button variant="primary" size="sm" onClick={() => setShowNewRecord(true)}>
            + Insert Row
          </Button>

          <Select
            className="w-[80px]"
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0) }}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </div>

        {/* Column filters */}
        {showFilters ? (
          <Card className="p-3 mb-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-muted-foreground uppercase font-medium">Column Filters</span>
              <Button
                size="xs"
                onClick={() => {
                  if (columns.length > 0) {
                    setFilters((prev) => [...prev, { column: columns[0]!.name, operator: "eq", value: "" }])
                  }
                }}
              >
                + Add Filter
              </Button>
            </div>
            {filters.length === 0 ? (
              <p className="text-xs text-zinc-600">No filters applied. Click + Add Filter to start.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {filters.map((f, i) => (
                  <ColumnFilterRow
                    key={i}
                    columns={columns}
                    filter={f}
                    onChange={(updated) => setFilters((prev) => prev.map((pf, pi) => pi === i ? updated : pf))}
                    onRemove={() => setFilters((prev) => prev.filter((_, pi) => pi !== i))}
                  />
                ))}
              </div>
            )}
          </Card>
        ) : null}

        {/* New record form */}
        {showNewRecord && currentTable ? (
          <div className="mb-4">
            <NewRecordForm
              table={currentTable}
              onSave={handleNewRecord}
              onCancel={() => setShowNewRecord(false)}
            />
          </div>
        ) : null}

        {/* Data display */}
        {viewMode === "table" ? (
          <Card className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === pagedRows.length && pagedRows.length > 0}
                      onChange={toggleSelectAll}
                      className="rounded border-border"
                    />
                  </Th>
                  {columns.map((col) => (
                    <Th
                      key={col.name}
                      onClick={(e) => handleSort(col.name, e.shiftKey)}
                      className="cursor-pointer select-none whitespace-nowrap"
                    >
                      <span className="flex items-center gap-1">
                        {col.name}
                        <code className="text-[0.6rem] text-zinc-600 font-normal">{col.type}</code>
                        {col.is_primary ? <Badge variant="indigo" className="text-[0.5rem] px-1 py-0">PK</Badge> : null}
                        {col.is_foreign_key ? <Badge variant="blue" className="text-[0.5rem] px-1 py-0">FK</Badge> : null}
                        <span className="text-primary text-[0.7rem]">{getSortIndicator(col.name)}</span>
                      </span>
                    </Th>
                  ))}
                  <Th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row, rowIdx) => {
                  const rowId = String(row[pkColumn])
                  return (
                    <tr
                      key={rowId}
                      className={cn(
                        "border-b border-border hover:bg-accent/50",
                        selectedIds.has(rowId) && "bg-primary/5"
                      )}
                    >
                      <Td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(rowId)}
                          onChange={() => toggleSelectRow(rowId)}
                          className="rounded border-border"
                        />
                      </Td>
                      {columns.map((col) => (
                        <Td
                          key={col.name}
                          onDoubleClick={() => handleCellEdit(rowIdx, col.name)}
                          className="cursor-pointer max-w-[300px]"
                        >
                          {editingCell?.rowIdx === rowIdx && editingCell.col === col.name ? (
                            col.enum_values ? (
                              <Select
                                className="w-full text-xs"
                                value={editValue}
                                onChange={(e) => { setEditValue(e.target.value); }}
                                onBlur={handleCellSave}
                                autoFocus
                              >
                                {col.enum_values.map((v) => (
                                  <option key={v} value={v}>{v}</option>
                                ))}
                              </Select>
                            ) : (
                              <Input
                                className="w-full px-1.5 py-0.5 text-xs"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={handleCellSave}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleCellSave()
                                  if (e.key === "Escape") setEditingCell(null)
                                }}
                                autoFocus
                              />
                            )
                          ) : (
                            <CellValue
                              value={row[col.name]}
                              column={col}
                              onRelationClick={handleRelationClick}
                            />
                          )}
                        </Td>
                      ))}
                      <Td>
                        <div className="flex gap-1">
                          <Button
                            size="xs"
                            onClick={() => setInspectedRow(row)}
                            title="Inspect record"
                          >
                            View
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive"
                            onClick={() => handleDeleteRow(rowId)}
                            title="Delete record"
                          >
                            Del
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  )
                })}
                {pagedRows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length + 2} className="text-center py-8 text-muted-foreground text-sm">
                      No records found
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Card>
        ) : (
          <CodeBlock>{JSON.stringify(pagedRows, null, 2)}</CodeBlock>
        )}

        {/* Pagination */}
        <div className="flex items-center gap-3 mt-3">
          <Button size="sm" onClick={() => setPage(0)} disabled={page === 0}>First</Button>
          <Button size="sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>Prev</Button>
          <span className="text-[0.8rem] text-muted-foreground">
            Page {page + 1} of {Math.max(1, totalPages)} ({filteredRows.length} rows)
          </span>
          <Button size="sm" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>Next</Button>
          <Button size="sm" onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>Last</Button>
        </div>

        {/* Record inspector */}
        {inspectedRow ? (
          <Card className="p-4 mt-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="m-0">Record Inspector</h3>
              <Button onClick={() => setInspectedRow(null)}>Close</Button>
            </div>
            <div className="font-mono text-sm">
              <JsonTreeNode data={inspectedRow} />
            </div>
          </Card>
        ) : null}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm ? (
        <DeleteConfirmation
          count={selectedIds.size}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      ) : null}
    </div>
  )
}
