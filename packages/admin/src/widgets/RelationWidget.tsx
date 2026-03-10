import React, { useState, useEffect, useCallback } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { WidgetProps } from "./FieldWidget.js"

export function RelationWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const client = useAdminClient()
  const [searchTerm, setSearchTerm] = useState("")
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const target = (config.options?.["target"] as string) ?? ""
  const displayField = (config.options?.["displayField"] as string) ?? "name"
  const isMulti = config.widget === "multirelation"
  const selectedIds = isMulti
    ? (Array.isArray(value) ? value as string[] : [])
    : (value ? [String(value)] : [])

  const search = useCallback(async (term: string) => {
    if (!target) return
    setLoading(true)
    try {
      let query = client.from(target as never).select().limit(20)
      if (term) {
        query = query.ilike(displayField, `%${term}%`)
      }
      const result = await query
      if (result.data) {
        setOptions(
          (result.data as Record<string, unknown>[]).map((row) => ({
            id: String(row["id"] ?? row[Object.keys(row)[0]!]),
            label: String(row[displayField] ?? row["id"] ?? ""),
          })),
        )
      }
    } finally {
      setLoading(false)
    }
  }, [client, target, displayField])

  useEffect(() => {
    if (open) void search(searchTerm)
  }, [open, searchTerm, search])

  const handleSelect = (id: string) => {
    if (isMulti) {
      const current = selectedIds
      if (current.includes(id)) {
        onChange(current.filter((x) => x !== id))
      } else {
        onChange([...current, id])
      }
    } else {
      onChange(id)
      setOpen(false)
    }
  }

  return (
    <div className="st-relation-widget">
      <div className="st-relation-selected">
        {selectedIds.length > 0 ? (
          selectedIds.map((id) => (
            <span key={id} className="st-relation-tag">
              {id}
              {!readOnly && (
                <button
                  type="button"
                  className="st-relation-tag-remove"
                  onClick={() => {
                    if (isMulti) {
                      onChange(selectedIds.filter((x) => x !== id))
                    } else {
                      onChange(null)
                    }
                  }}
                >
                  x
                </button>
              )}
            </span>
          ))
        ) : (
          <span className="st-relation-empty">None selected</span>
        )}
      </div>

      {!readOnly && (
        <div className="st-relation-picker">
          <button
            type="button"
            className="st-btn st-btn-sm"
            onClick={() => { setOpen(!open) }}
          >
            {open ? "Close" : "Select"}
          </button>

          {open && (
            <div className="st-relation-dropdown">
              <input
                type="search"
                className="st-input st-input-sm"
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value) }}
              />
              {loading ? (
                <div className="st-relation-loading">Loading...</div>
              ) : (
                <ul className="st-relation-options">
                  {options.map((opt) => (
                    <li
                      key={opt.id}
                      className={`st-relation-option${selectedIds.includes(opt.id) ? " st-relation-option--selected" : ""}`}
                    >
                      <button
                        type="button"
                        onClick={() => { handleSelect(opt.id) }}
                      >
                        {opt.label}
                      </button>
                    </li>
                  ))}
                  {options.length === 0 && (
                    <li className="st-relation-empty">No results</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
