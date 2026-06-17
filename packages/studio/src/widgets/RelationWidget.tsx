import React, { useState, useEffect, useCallback, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { FieldWidget } from "./FieldWidget.js"
import { Slideover } from "../components/Slideover.js"
import type { WidgetProps } from "./FieldWidget.js"
import type { SupatypeClient } from "@supatype/client"
import {
  fetchAuthUserById,
  fetchAuthUsers,
  fetchAuthUsersByIds,
  inferAuthUserRelation,
  relationDisplayFromAuthUser,
  SYSTEM_AUTH_USER,
  type RelationDisplay,
} from "../lib/relation-auth-users.js"

// ─── Cross-schema relation helpers ───────────────────────────────────────────

interface RelationOption {
  id: string
  label: string
  sublabel?: string
  initials: string
}

function resolveTarget(raw: string, isAuthUser: boolean): { table: string; schema?: string } {
  if (isAuthUser || raw === SYSTEM_AUTH_USER) return { table: "users", schema: "auth" }
  return { table: raw }
}

function initialsFromLabel(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return label.slice(0, 2).toUpperCase() || "?"
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

async function postgrestQuery(
  client: SupatypeClient,
  table: string,
  schema: string | undefined,
  params: Record<string, string>,
): Promise<{ data: Record<string, unknown>[]; error: { message: string } | null }> {
  const url = new URL(`${client.url}/rest/v1/${table}`)
  url.searchParams.set("select", "*")
  for (const [k, v] of Object.entries(params)) {
    if (k === "limit") url.searchParams.set("limit", v)
    else url.searchParams.set(k, v)
  }
  const token = client.serviceRoleKey
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { apikey: token, Authorization: `Bearer ${token}` } : {}),
    ...(schema ? { "Accept-Profile": schema } : {}),
  }
  try {
    const res = await fetch(url.toString(), { headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>
      return { data: [], error: { message: String(err["message"] ?? `HTTP ${res.status}`) } }
    }
    return { data: await res.json() as Record<string, unknown>[], error: null }
  } catch (e) {
    return { data: [], error: { message: e instanceof Error ? e.message : "Network error" } }
  }
}

function rowToOption(row: Record<string, unknown>, displayField: string): RelationOption {
  const id = String(row["id"] ?? row[Object.keys(row)[0]!] ?? "")
  const label = String(row[displayField] ?? row["name"] ?? row["title"] ?? row["email"] ?? id)
  return { id, label, initials: initialsFromLabel(label) }
}

// ─── Auth user preview ────────────────────────────────────────────────────────

function AuthUserPreview({
  userId,
  onNavigateAway,
}: {
  userId: string
  onNavigateAway?: () => void
}): React.ReactElement {
  const client = useAdminClient()
  const navigate = useNavigate()
  const [user, setUser] = useState<Awaited<ReturnType<typeof fetchAuthUserById>>>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    void fetchAuthUserById(client, userId)
      .then((u) => { if (!u) setError("User not found"); setUser(u) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [client, userId])

  if (loading) return <div className="st-slideover-loading">Loading user…</div>
  if (error || !user) return <div className="st-slideover-error">{error ?? "User not found"}</div>

  const display = relationDisplayFromAuthUser(user)
  return (
    <div className="st-auth-user-preview">
      <div className="st-relation-chip st-relation-chip--large">
        <span className="st-relation-avatar st-relation-avatar--large">{display.initials}</span>
        <span className="st-relation-chip-text">
          <span className="st-relation-chip-label">{display.label}</span>
          {display.sublabel && <span className="st-relation-chip-sublabel">{display.sublabel}</span>}
        </span>
      </div>
      <dl className="st-auth-user-preview-meta">
        <div><dt>User ID</dt><dd className="st-auth-user-preview-id">{user.id}</dd></div>
        {user.email && <div><dt>Email</dt><dd>{user.email}</dd></div>}
        {user.name && <div><dt>Name</dt><dd>{user.name}</dd></div>}
      </dl>
      <button
        type="button"
        className="st-btn st-btn-sm"
        onClick={() => {
          navigate(`/authentication/users?user=${encodeURIComponent(user.id)}`)
          onNavigateAway?.()
        }}
      >
        Open in Users
      </button>
    </div>
  )
}

// ─── Related record preview (rendered inside the slideover) ───────────────────

function ModelRelationPreview({ target, recordId }: { target: string; recordId: string }): React.ReactElement {
  const client = useAdminClient()
  const config = useAdminConfig()
  const [record, setRecord] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { table, schema } = resolveTarget(target, false)
  const model = config.models.find((m) => m.tableName === table)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setRecord(null)
    const pk = model?.primaryKey ?? "id"
    postgrestQuery(client, table, schema, { [pk]: `eq.${recordId}`, limit: "1" })
      .then((r) => {
        if (r.error) setError(r.error.message)
        else setRecord(r.data[0] ?? null)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load")
      })
      .finally(() => setLoading(false))
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

function RelationPreview({
  target,
  recordId,
  isAuthUser,
  onClose,
}: {
  target: string
  recordId: string
  isAuthUser: boolean
  onClose?: () => void
}): React.ReactElement {
  if (isAuthUser) {
    return onClose
      ? <AuthUserPreview userId={recordId} onNavigateAway={onClose} />
      : <AuthUserPreview userId={recordId} />
  }
  return <ModelRelationPreview target={target} recordId={recordId} />
}

// ─── Shared UI pieces ─────────────────────────────────────────────────────────

function RelationChip({
  display,
  loading,
  compact,
}: {
  display: RelationDisplay
  loading?: boolean
  compact?: boolean
}): React.ReactElement {
  return (
    <span className={`st-relation-chip${compact ? " st-relation-chip--compact" : ""}`}>
      <span className="st-relation-avatar">{display.initials}</span>
      <span className="st-relation-chip-text">
        <span className={`st-relation-chip-label${loading ? " st-relation-chip-label--loading" : ""}`}>
          {loading ? "Loading…" : display.label}
        </span>
        {!loading && display.sublabel && (
          <span className="st-relation-chip-sublabel">{display.sublabel}</span>
        )}
      </span>
    </span>
  )
}

function RelationOptionRow({
  opt,
  selected,
  isAuthUser,
  onSelect,
}: {
  opt: RelationOption
  selected: boolean
  isAuthUser: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        className={`st-relation-option${selected ? " st-relation-option--selected" : ""}`}
        onClick={onSelect}
      >
        <span className="st-relation-avatar st-relation-avatar--sm">{opt.initials}</span>
        <span className="st-relation-option-text">
          <span className="st-relation-option-label">{opt.label}</span>
          {opt.sublabel && <span className="st-relation-option-sublabel">{opt.sublabel}</span>}
        </span>
        {!isAuthUser && (
          <span className="st-relation-option-id">{truncateId(opt.id)}</span>
        )}
        {selected && <span className="st-relation-option-check">✓</span>}
      </button>
    </li>
  )
}

// ─── RelationWidget ───────────────────────────────────────────────────────────

export function RelationWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const client = useAdminClient()
  const [searchTerm, setSearchTerm] = useState("")
  const [options, setOptions] = useState<RelationOption[]>([])
  const [displayMap, setDisplayMap] = useState<Record<string, RelationDisplay>>({})
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [slideoverId, setSlideoverId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  const rawTarget = (config.options?.["target"] as string) ?? ""
  const isAuthUser = inferAuthUserRelation(rawTarget, config.name, config.label)
  const { table: target, schema: targetSchema } = resolveTarget(rawTarget, isAuthUser)
  const defaultDisplay = isAuthUser ? "email" : "name"
  const displayField = (config.options?.["displayField"] as string) ?? defaultDisplay
  const isMulti = config.widget === "multirelation"
  const searchPlaceholder = isAuthUser
    ? "Search by email or name…"
    : `Search ${config.label.toLowerCase()}…`

  const selectedIds: string[] = isMulti
    ? (Array.isArray(value) ? (value as string[]) : [])
    : (value ? [String(value)] : [])

  const mergeDisplay = useCallback((entries: Map<string, RelationDisplay> | Record<string, RelationDisplay>) => {
    setDisplayMap((prev) => {
      const next = { ...prev }
      const pairs = entries instanceof Map ? entries.entries() : Object.entries(entries)
      for (const [id, display] of pairs) next[id] = display
      return next
    })
  }, [])

  const fetchOptions = useCallback(async (term: string) => {
    if (!target && !isAuthUser) return
    setLoading(true)
    try {
      if (isAuthUser) {
        const users = await fetchAuthUsers(client, term)
        const items = users.map((u) => {
          const display = relationDisplayFromAuthUser(u)
          const opt: RelationOption = {
            id: u.id,
            label: display.label,
            initials: display.initials,
          }
          if (display.sublabel) opt.sublabel = display.sublabel
          return opt
        })
        setOptions(items)
        mergeDisplay(Object.fromEntries(users.map((u) => [u.id, relationDisplayFromAuthUser(u)])))
        return
      }
      const params: Record<string, string> = { limit: "30" }
      if (term) params[displayField] = `ilike.%${term}%`
      const result = await postgrestQuery(client, target, targetSchema, params)
      if (!result.error && result.data) {
        const items = result.data.map((row) => rowToOption(row, displayField))
        setOptions(items)
        mergeDisplay(Object.fromEntries(items.map((o) => [o.id, { label: o.label, initials: o.initials }])))
      }
    } finally {
      setLoading(false)
    }
  }, [client, target, targetSchema, displayField, isAuthUser, mergeDisplay])

  useEffect(() => {
    if (!pickerOpen) return
    const t = setTimeout(() => { void fetchOptions(searchTerm) }, searchTerm ? 200 : 0)
    return () => clearTimeout(t)
  }, [pickerOpen, searchTerm, fetchOptions])

  const selectedKey = selectedIds.join(",")
  useEffect(() => {
    const unresolved = selectedIds.filter((id) => id && !displayMap[id])
    if (!unresolved.length) return

    setResolvingIds((prev) => new Set([...prev, ...unresolved]))
    void (async () => {
      try {
        if (isAuthUser) {
          mergeDisplay(await fetchAuthUsersByIds(client, unresolved))
        } else if (target) {
          const result = await postgrestQuery(client, target, targetSchema, {
            id: `in.(${unresolved.join(",")})`,
          })
          if (!result.error && result.data) {
            const entries: Record<string, RelationDisplay> = {}
            result.data.forEach((row) => {
              const opt = rowToOption(row, displayField)
              entries[opt.id] = { label: opt.label, initials: opt.initials }
            })
            mergeDisplay(entries)
          }
        }
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev)
          unresolved.forEach((id) => next.delete(id))
          return next
        })
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, target, targetSchema, displayField, isAuthUser])

  useEffect(() => {
    if (pickerOpen) setTimeout(() => searchRef.current?.focus(), 40)
  }, [pickerOpen])

  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
        setSearchTerm("")
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [pickerOpen])

  const displayForId = (id: string): RelationDisplay => {
    if (displayMap[id]) return displayMap[id]!
    if (resolvingIds.has(id)) return { label: "Loading…", initials: "…" }
    return { label: isAuthUser ? "Unknown user" : truncateId(id), initials: "?" }
  }

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

  const closePicker = () => {
    setPickerOpen(false)
    setSearchTerm("")
  }

  const openPicker = () => {
    if (readOnly) return
    setPickerOpen(true)
    setSearchTerm("")
  }

  const renderDropdown = (inlineSearch = false): React.ReactElement => (
    <div className="st-relation-dropdown">
      {!inlineSearch && (
        <div className="st-relation-search">
          <input
            ref={searchRef}
            type="search"
            className="st-input st-input-sm"
            placeholder={searchPlaceholder}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      {loading ? (
        <div className="st-relation-loading">Searching…</div>
      ) : (
        <ul className="st-relation-options" role="listbox" aria-label={`${config.label} options`}>
          {options.map((opt) => (
            <RelationOptionRow
              key={opt.id}
              opt={opt}
              selected={selectedIds.includes(opt.id)}
              isAuthUser={isAuthUser}
              onSelect={() => handleSelect(opt.id)}
            />
          ))}
          {options.length === 0 && (
            <li className="st-relation-option-empty">
              {searchTerm ? `No results for "${searchTerm}"` : "No records found"}
            </li>
          )}
        </ul>
      )}
    </div>
  )

  const renderTagActions = (id: string): React.ReactElement => (
    <>
      <button
        type="button"
        className="st-relation-action-btn"
        title={isAuthUser ? "View user" : "View record"}
        onClick={() => setSlideoverId(id)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3C4.5 3 1.5 8 1.5 8C1.5 8 4.5 13 8 13C11.5 13 14.5 8 14.5 8C14.5 8 11.5 3 8 3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
        </svg>
      </button>
      {!readOnly && (
        <button
          type="button"
          className="st-relation-action-btn st-relation-action-btn--remove"
          title="Remove"
          onClick={() => handleRemove(id)}
        >
          ✕
        </button>
      )}
    </>
  )

  const slideoverTitle = slideoverId
    ? `${config.label} — ${displayMap[slideoverId]?.label ?? slideoverId}`
    : config.label

  return (
    <div className="st-relation-widget">
      {isMulti ? (
        <>
          <div className="st-relation-selected">
            {selectedIds.length > 0 ? selectedIds.map((id) => {
              const display = displayForId(id)
              return (
                <span key={id} className="st-relation-tag">
                  <RelationChip display={display} loading={resolvingIds.has(id)} compact />
                  {renderTagActions(id)}
                </span>
              )
            }) : (
              <span className="st-relation-empty">None selected</span>
            )}
          </div>
          {!readOnly && (
            <div className="st-relation-picker" ref={pickerRef}>
              <button type="button" className="st-btn st-btn-sm" onClick={() => pickerOpen ? closePicker() : openPicker()}>
                {pickerOpen ? "Close" : "Add…"}
              </button>
              {pickerOpen && renderDropdown()}
            </div>
          )}
        </>
      ) : (
        <div className="st-relation-combobox" ref={pickerRef}>
          {pickerOpen && !readOnly ? (
            <>
              <div className="st-relation-trigger st-relation-trigger--open st-relation-trigger--search">
                <input
                  ref={searchRef}
                  type="search"
                  className="st-relation-trigger-input"
                  placeholder={searchPlaceholder}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  autoComplete="off"
                  aria-label={config.label}
                />
                <button
                  type="button"
                  className="st-relation-action-btn"
                  title="Close"
                  onClick={closePicker}
                >
                  <span className="st-relation-chevron st-relation-chevron--open" aria-hidden="true">▾</span>
                </button>
              </div>
              {renderDropdown(true)}
            </>
          ) : (
            <div
              className={`st-relation-trigger${readOnly ? " st-relation-trigger--readonly" : ""}`}
              onClick={() => { if (!readOnly) openPicker() }}
              onKeyDown={(e) => {
                if (!readOnly && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault()
                  openPicker()
                }
              }}
              role="combobox"
              aria-expanded={false}
              aria-haspopup="listbox"
              tabIndex={readOnly ? -1 : 0}
            >
              {selectedIds.length > 0 ? (
                <button
                  type="button"
                  className="st-relation-chip-hit"
                  title={isAuthUser ? "View user" : "View record"}
                  onClick={(e) => { e.stopPropagation(); setSlideoverId(selectedIds[0]!) }}
                >
                  <RelationChip
                    display={displayForId(selectedIds[0]!)}
                    loading={resolvingIds.has(selectedIds[0]!)}
                  />
                </button>
              ) : (
                <span className="st-relation-placeholder">{searchPlaceholder}</span>
              )}
              <div className="st-relation-trigger-actions">
                {selectedIds[0] && !readOnly && (
                  <button
                    type="button"
                    className="st-relation-action-btn st-relation-action-btn--remove"
                    title="Clear"
                    onClick={(e) => { e.stopPropagation(); handleRemove(selectedIds[0]!) }}
                  >
                    ✕
                  </button>
                )}
                {selectedIds[0] && (
                  <button
                    type="button"
                    className="st-relation-action-btn"
                    title={isAuthUser ? "View user" : "View record"}
                    onClick={(e) => { e.stopPropagation(); setSlideoverId(selectedIds[0]!) }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 3C4.5 3 1.5 8 1.5 8C1.5 8 4.5 13 8 13C11.5 13 14.5 8 14.5 8C14.5 8 11.5 3 8 3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4"/>
                    </svg>
                  </button>
                )}
                {!readOnly && (
                  <span className="st-relation-chevron" aria-hidden="true">▾</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <Slideover open={slideoverId !== null} onClose={() => setSlideoverId(null)} title={slideoverTitle}>
        {slideoverId && (
          <RelationPreview
            target={rawTarget}
            recordId={slideoverId}
            isAuthUser={isAuthUser}
            onClose={() => setSlideoverId(null)}
          />
        )}
      </Slideover>
    </div>
  )
}
