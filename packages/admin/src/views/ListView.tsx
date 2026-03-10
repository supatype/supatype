import React, { useState, useEffect, useCallback } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { ModelConfig, FieldConfig } from "../config.js"

interface ListViewProps {
  model: ModelConfig
  onNavigate: (path: string) => void
}

interface SortState {
  field: string
  direction: "asc" | "desc"
}

export function ListView({ model, onNavigate }: ListViewProps): React.ReactElement {
  const client = useAdminClient()
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
        // Use ilike on first search field for simplicity
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
          <button
            type="button"
            className="st-btn st-btn-primary"
            onClick={() => { onNavigate(`/collections/${model.name}/create`) }}
          >
            Create {model.label}
          </button>
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
            <button type="button" className="st-btn st-btn-danger" onClick={() => { void handleBulkDelete() }}>
              Delete selected
            </button>
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
                    onClick={() => { onNavigate(`/collections/${model.name}/${id}`) }}
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
                        <CellRenderer value={row[col.name]} field={col} />
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

function CellRenderer({ value, field }: { value: unknown; field: FieldConfig }): React.ReactElement {
  if (value === null || value === undefined) {
    return <span className="st-cell-null">—</span>
  }

  switch (field.widget) {
    case "boolean":
      return <span className={`st-cell-bool st-cell-bool--${value ? "true" : "false"}`}>{value ? "Yes" : "No"}</span>
    case "image":
      if (typeof value === "object" && value !== null && "path" in (value as Record<string, unknown>)) {
        return <span className="st-cell-image">[Image]</span>
      }
      return <span>{String(value)}</span>
    case "publish":
      return <span className={`st-cell-status st-cell-status--${String(value)}`}>{String(value)}</span>
    case "date":
    case "datetime":
      return <span className="st-cell-date">{new Date(String(value)).toLocaleDateString()}</span>
    default:
      return <span className="st-cell-text">{truncate(String(value), 100)}</span>
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text
}
