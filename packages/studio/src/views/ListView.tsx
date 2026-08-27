import React, { useState, useEffect, useCallback } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { getLocalizedFieldValue } from "../lib/localized-field.js"
import type { ModelConfig, FieldConfig } from "../config.js"
import {
  cellAccess,
  isOperationOffered,
  useStudioFieldAccess,
  type CellAccess,
} from "../hooks/useStudioFieldAccess.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"

interface ListViewProps {
  model: ModelConfig
  onNavigate: (path: string) => void
}

interface SortState {
  field: string
  direction: "asc" | "desc"
}

export function ListView({ model, onNavigate }: ListViewProps): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const client = useAdminClient()
  const { currentLocale, defaultLocale } = useLocale()
  const fieldAccess = useStudioFieldAccess()
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<SortState | null>(null)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const pageSize = 25

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let query = client.from(model.tableName as never).select()

      if (search && model.searchFields.length > 0) {
        query = query.ilike(model.searchFields[0]!, `%${search}%`)
      }

      if (sort) {
        query = query.order(sort.field, { ascending: sort.direction === "asc" })
      }

      query = query.range(page * pageSize, (page + 1) * pageSize - 1)

      const result = await query
      if (result.error) {
        setError(result.error.message)
      } else {
        setRows((result.data ?? []) as Record<string, unknown>[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
    }
  }, [client, model.tableName, model.searchFields, search, sort, page])

  useEffect(() => { void fetchData() }, [fetchData])

  const columns = model.listColumns
    .map((name) => model.fields.find((f) => f.name === name))
    .filter((f): f is FieldConfig => f !== undefined)

  const toggleSort = (fieldName: string) => {
    setSort((prev) => {
      if (prev?.field === fieldName) {
        return prev.direction === "asc"
          ? { field: fieldName, direction: "desc" }
          : null
      }
      return { field: fieldName, direction: "asc" }
    })
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === rows.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(rows.map((r) => String(r[model.primaryKey]))))
    }
  }

  const handleBulkDelete = async () => {
    if (selected.size === 0) return
    for (const id of selected) {
      await client.from(model.tableName as never).delete().eq(model.primaryKey, id)
    }
    setSelected(new Set())
    void fetchData()
  }

  return (
    <div className="st-list-view">
      <Header
        title={model.labelPlural}
        actions={
          // Withdrawn only on a settled deny: `row` means some records allow it, and the
          // server is what refuses either way.
          isOperationOffered(fieldAccess, model.tableName, "create") ? (
            <button
              type="button"
              className="st-btn st-btn-primary"
              onClick={() => { onNavigate(`/models/${model.name}/create`) }}
            >
              Create {model.label}
            </button>
          ) : null
        }
      />

      <div className="st-list-toolbar">
        {model.searchFields.length > 0 && (
          <input
            type="search"
            className="st-search-input"
            placeholder={`Search ${model.labelPlural.toLowerCase()}...`}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          />
        )}

        {selected.size > 0 && (
          <div className="st-bulk-actions">
            <span>{selected.size} selected</span>
            {isOperationOffered(fieldAccess, model.tableName, "delete") && (
              <button type="button" className="st-btn st-btn-danger" onClick={() => { void handleBulkDelete() }}>
                Delete selected
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="st-error" role="alert">{error}</div>}

      <div className="st-table-wrapper">
        <table className="st-table">
          <thead>
            <tr>
              <th className="st-table-check">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleSelectAll}
                  aria-label="Select all"
                />
              </th>
              {columns.map((col) => (
                <th
                  key={col.name}
                  className={`st-table-header${col.sortable !== false ? " st-table-header--sortable" : ""}`}
                  onClick={col.sortable !== false ? () => { toggleSort(col.name) } : undefined}
                  style={col.listWidth ? { width: col.listWidth } : undefined}
                >
                  {col.label}
                  {sort?.field === col.name && (
                    <span className="st-sort-indicator">
                      {sort.direction === "asc" ? " \u2191" : " \u2193"}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length + 1} className="st-table-loading">
                  Loading...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="st-table-empty">
                  No {model.labelPlural.toLowerCase()} found.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const id = String(row[model.primaryKey])
                return (
                  <tr
                    key={id}
                    className={`st-table-row${selected.has(id) ? " st-table-row--selected" : ""}`}
                    onClick={() => { onNavigate(`/models/${model.name}/${id}`) }}
                  >
                    <td className="st-table-check" onClick={(e) => { e.stopPropagation() }}>
                      <input
                        type="checkbox"
                        checked={selected.has(id)}
                        onChange={() => { toggleSelect(id) }}
                        aria-label={`Select row ${id}`}
                      />
                    </td>
                    {columns.map((col) => (
                      <td key={col.name} className="st-table-cell">
                        <AccessAwareCell
                          access={cellAccess(fieldAccess, model.tableName, col.name, row[col.name])}
                        >
                          <CellRenderer
                            value={row[col.name]}
                            field={col}
                            currentLocale={currentLocale}
                            defaultLocale={defaultLocale}
                          />
                        </AccessAwareCell>
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="st-pagination">
        <button
          type="button"
          className="st-btn"
          disabled={page === 0}
          onClick={() => { setPage((p) => Math.max(0, p - 1)) }}
        >
          Previous
        </button>
        <span className="st-page-info">Page {page + 1}</span>
        <button
          type="button"
          className="st-btn"
          disabled={rows.length < pageSize}
          onClick={() => { setPage((p) => p + 1) }}
        >
          Next
        </button>
      </div>
    </div>
  )
}

function CellRenderer({
  value,
  field,
  currentLocale,
  defaultLocale,
}: {
  value: unknown
  field: FieldConfig
  currentLocale: string
  defaultLocale: string
}): React.ReactElement {
  const resolved = getLocalizedFieldValue(value, field.localized === true, currentLocale, defaultLocale)

  if (resolved === null || resolved === undefined) {
    return <span className="st-cell-null">-</span>
  }

  switch (field.widget) {
    case "boolean":
      return <span className={`st-cell-bool st-cell-bool--${resolved ? "true" : "false"}`}>{resolved ? "Yes" : "No"}</span>
    case "image":
    case "file":
      if (typeof resolved === "object" && resolved !== null && "path" in (resolved as Record<string, unknown>)) {
        return <span className="st-cell-image">[Image]</span>
      }
      return <span>{formatCellText(resolved)}</span>
    case "publish":
      return <span className={`st-cell-status st-cell-status--${String(resolved)}`}>{String(resolved)}</span>
    case "date":
    case "datetime":
      return <span className="st-cell-date">{new Date(String(resolved)).toLocaleDateString()}</span>
    case "json":
      return <span className="st-cell-text">{truncate(formatCellText(resolved), 100)}</span>
    default:
      return <span className="st-cell-text">{truncate(formatCellText(resolved), 100)}</span>
  }
}

function formatCellText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text
}

/**
 * Renders a cell with its access state, and **never hides a value that came back**.
 *
 * A withheld column arrives as null, which as an empty cell is indistinguishable from a record
 * that simply has no value, so `hidden` shows a lock instead of nothing. But that only holds
 * where masking is actually being applied and the verdict is settled: an empty cell for an
 * elevated caller, or under a per-row rule, is not evidence of anything, and claiming otherwise
 * would tell the reader a record is hiding a value it does not have.
 *
 * `revealed` is the case that matters for an administrator, who acts elevated by default. The
 * masking extension exempts the service role, so restricted columns reach them in full. Blanking
 * those would hide data they are entitled to and make the restriction look like it applies to
 * them.
 */
function AccessAwareCell({
  access,
  children,
}: {
  access: CellAccess
  children: React.ReactNode
}): React.ReactElement {
  if (access === "hidden") {
    return (
      <span
        className="st-cell-masked"
        title="Hidden by a field access rule"
        aria-label="Hidden by a field access rule"
      >
        &#128274;
      </span>
    )
  }

  if (access === "unknown") {
    // Restricted, empty, and per-row: this record either withholds the value or has none, and
    // nothing available here can tell which. Say that rather than pick one.
    return (
      <span
        className="st-cell-masked st-cell-masked-unknown"
        title="Hidden by a field access rule, or empty, this column is restricted per record"
        aria-label="Hidden by a field access rule, or empty"
      >
        &#128274;?
      </span>
    )
  }

  if (access === "revealed") {
    return (
      <span className="st-cell-restricted">
        {children}
        <span
          className="st-cell-restricted-marker"
          title="Access-controlled field: other callers may not see this value"
          aria-label="Access-controlled field"
        >
          &#128274;
        </span>
      </span>
    )
  }

  return <>{children}</>
}
