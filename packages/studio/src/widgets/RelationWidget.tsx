import React, { useState, useEffect, useCallback, useRef } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { FieldWidget } from "./FieldWidget.js"
import { Slideover } from "../components/Slideover.js"
import type { WidgetProps } from "./FieldWidget.js"

// ─── Related record preview (rendered inside the slideover) ───────────────────

function RelationPreview({ target, recordId }: { target: string; recordId: string }): React.ReactElement {
  const client = useAdminClient()
  const config = useAdminConfig()
  const [record, setRecord] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const model = config.models.find((m) => m.tableName === target)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setRecord(null)
    const pk = model?.primaryKey ?? "id"
    void (client
      .from(target as never)
      .select()
      .eq(pk as never, recordId as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>
    ).then((r) => {
      if (r.error) setError(r.error.message)
      else {
        const rows = r.data as Record<string, unknown>[]
        setRecord(rows?.[0] ?? null)
      }
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Failed to load")
    }).finally(() => {
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, recordId])

  if (loading) return <div className="st-slideover-loading">Loading…</div>
  if (error) return <div className="st-slideover-error">{error}</div>
  if (!record) return <div className="st-slideover-empty">Record not found</div>

  if (model) {
    const fields = model.fields.filter((f) => !f.hidden && f.widget !== "blocks")
    return (
      <div className="st-slideover-fields">
        {fields.map((f) => (
          <FieldWidget key={f.name} config={f} value={record[f.name]} onChange={() => {}} readOnly />
        ))}
      </div>
    )
  }

  return <pre className="st-slideover-json">{JSON.stringify(record, null, 2)}</pre>
}

// ─── RelationWidget ───────────────────────────────────────────────────────────

export function RelationWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const client = useAdminClient()
  const [searchTerm, setSearchTerm] = useState("")
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>([])
  const [labelMap, setLabelMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [slideoverId, setSlideoverId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  const target = (config.options?.["target"] as string) ?? ""
  const displayField = (config.options?.["displayField"] as string) ?? "name"
  const isMulti = config.widget === "multirelation"

  const selectedIds: string[] = isMulti
    ? (Array.isArray(value) ? (value as string[]) : [])
    : (value ? [String(value)] : [])

  // ─── Fetch picker options (debounced) ─────────────────────────────────────

  const fetchOptions = useCallback(async (term: string) => {
    if (!target) return
    setLoading(true)
    try {
      let q = client.from(target as never).select().limit(30)
      if (term) q = (q as unknown as { ilike: (f: string, v: string) => typeof q }).ilike(displayField, `%${term}%`)
      const result = await (q as unknown as Promise<{ data: unknown }>)
      if (result.data) {
        const rows = result.data as Record<string, unknown>[]
        const items = rows.map((row) => ({
          id: String(row["id"] ?? row[Object.keys(row)[0]!] ?? ""),
          label: String(row[displayField] ?? row["id"] ?? ""),
        }))
        setOptions(items)
        setLabelMap((prev) => {
          const next = { ...prev }
          items.forEach(({ id, label }) => { next[id] = label })
          return next
        })
      }
    } finally {
      setLoading(false)
    }
  }, [client, target, displayField])

  useEffect(() => {
    if (!pickerOpen) return
    const t = setTimeout(() => { void fetchOptions(searchTerm) }, searchTerm ? 200 : 0)
    return () => clearTimeout(t)
  }, [pickerOpen, searchTerm, fetchOptions])

  // Resolve display labels for already-selected ids missing from the map
  const selectedKey = selectedIds.join(",")
  useEffect(() => {
    const unresolved = selectedIds.filter((id) => id && !labelMap[id])
    if (!unresolved.length || !target) return
    void (async () => {
      const result = await (
        (client.from(target as never).select() as unknown as { in: (f: string, v: string[]) => Promise<{ data: unknown }> }).in("id", unresolved)
      )
      if (result.data) {
        const rows = result.data as Record<string, unknown>[]
        setLabelMap((prev) => {
          const next = { ...prev }
          rows.forEach((row) => {
            const id = String(row["id"] ?? "")
            const label = String(row[displayField] ?? row["id"] ?? id)
            if (id) next[id] = label
          })
          return next
        })
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, target, displayField])

  // Focus search on open
  useEffect(() => {
    if (pickerOpen) setTimeout(() => searchRef.current?.focus(), 40)
  }, [pickerOpen])

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [pickerOpen])

  const handleSelect = (id: string) => {
    if (isMulti) {
      onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id])
    } else {
      onChange(id)
      setPickerOpen(false)
      setSearchTerm("")
    }
  }

  const handleRemove = (id: string) => {
    if (isMulti) onChange(selectedIds.filter((x) => x !== id))
    else onChange(null)
  }

  return (
    <div className="st-relation-widget">
      {/* ── Selected tags ── */}
      <div className="st-relation-selected">
        {selectedIds.length > 0 ? selectedIds.map((id) => (
          <span key={id} className="st-relation-tag">
            <span className="st-relation-tag-label">{labelMap[id] ?? id}</span>
            <button
              type="button"
              className="st-relation-tag-view"
              title="View record"
              onClick={() => setSlideoverId(id)}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 3C4.5 3 1.5 8 1.5 8C1.5 8 4.5 13 8 13C11.5 13 14.5 8 14.5 8C14.5 8 11.5 3 8 3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
              </svg>
            </button>
            {!readOnly && (
              <button
                type="button"
                className="st-relation-tag-remove"
                title="Remove"
                onClick={() => handleRemove(id)}
              >
                ✕
              </button>
            )}
          </span>
        )) : (
          <span className="st-relation-empty">None selected</span>
        )}
      </div>

      {/* ── Picker ── */}
      {!readOnly && (
        <div className="st-relation-picker" ref={pickerRef}>
          <button
            type="button"
            className="st-btn st-btn-sm"
            onClick={() => {
              setPickerOpen((v) => !v)
              if (!pickerOpen) setSearchTerm("")
            }}
          >
            {pickerOpen ? "Close" : "Select…"}
          </button>

          {pickerOpen && (
            <div className="st-relation-dropdown">
              <div className="st-relation-search">
                <input
                  ref={searchRef}
                  type="search"
                  className="st-input st-input-sm"
                  placeholder={`Search ${config.label}…`}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  autoComplete="off"
                />
              </div>

              {loading ? (
                <div className="st-relation-loading">Searching…</div>
              ) : (
                <ul className="st-relation-options" role="listbox" aria-label={`${config.label} options`}>
                  {options.map((opt) => {
                    const selected = selectedIds.includes(opt.id)
                    return (
                      <li key={opt.id} role="option" aria-selected={selected}>
                        <button
                          type="button"
                          className={`st-relation-option${selected ? " st-relation-option--selected" : ""}`}
                          onClick={() => handleSelect(opt.id)}
                        >
                          <span className="st-relation-option-label">{opt.label}</span>
                          <span className="st-relation-option-id">{opt.id.length > 12 ? `${opt.id.slice(0, 8)}…` : opt.id}</span>
                          {selected && <span className="st-relation-option-check">✓</span>}
                        </button>
                      </li>
                    )
                  })}
                  {options.length === 0 && (
                    <li className="st-relation-option-empty">
                      {searchTerm ? `No results for "${searchTerm}"` : "No records found"}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Slideover ── */}
      <Slideover
        open={slideoverId !== null}
        onClose={() => setSlideoverId(null)}
        title={slideoverId ? `${config.label} — ${labelMap[slideoverId] ?? slideoverId}` : config.label}
      >
        {slideoverId && <RelationPreview target={target} recordId={slideoverId} />}
      </Slideover>
    </div>
  )
}
