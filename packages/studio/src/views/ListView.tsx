import React, { useState, useEffect, useCallback, useMemo } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useLocale } from "../hooks/useLocale.js"
import { defaultFirstLocales, getLocalizedFieldValue } from "../lib/localized-field.js"
import { isJsonObject } from "../lib/json.js"
import type { ModelConfig, FieldConfig } from "../config.js"
import {
  cellAccess,
  isOperationOffered,
  useStudioFieldAccess,
  type CellAccess,
} from "../hooks/useStudioFieldAccess.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import { Badge, Button, DestructiveAnswers, Dialog } from "../components/ui.js"
import type { SupatypeClient } from "@supatype/client"
import { anyFieldContains, searchColumns } from "../lib/postgrest-search.js"
import { formatFieldValue } from "../lib/field-display.js"
import { isUuid } from "../lib/uuid.js"
import { UuidCell } from "../components/UuidCell.js"
import { WithheldValue } from "../components/WithheldValue.js"
import { useRowsFieldAccess } from "../hooks/useRecordAccess.js"
import {
  fetchRecordStates,
  publishableLocales,
  WHOLE_RECORD,
  type RecordState,
} from "../lib/publishing.js"
import { stateLabels } from "../components/PublishBar.js"
import { RefreshControls } from "../components/RefreshControls.js"
import { useListFreshness } from "../hooks/useListFreshness.js"
import { listOrder, modelKeyColumns, withOrder, type ListOrder } from "../lib/list-order.js"

interface ListViewProps {
  model: ModelConfig
  onNavigate: (path: string) => void
}

export function ListView({ model, onNavigate }: ListViewProps): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const client = useAdminClient()
  const { currentLocale, defaultLocale, locales: projectLocales } = useLocale()
  const fieldAccess = useStudioFieldAccess()
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<ListOrder | null>(null)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Its own state, not `error`: the refetch after a delete clears that one before it starts.
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const pageSize = 25
  // What the search box matches on: a localized field by its value in each locale, and no field
  // `ilike` cannot read, which failed the whole search.
  // Keyed by the codes: the locale list can be a fresh array each render, and a fresh `searchable`
  // would refetch the list on every one.
  const localeKey = defaultFirstLocales(defaultLocale, projectLocales).join(",")
  const searchable = useMemo(
    () => searchColumns(model.fields, model.searchFields, localeKey.split(",")),
    [model.fields, model.searchFields, localeKey],
  )

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let query = client.from(model.tableName).select()

      // Every search field, on the server: it searched only the first.
      if (search && searchable.length > 0) {
        query = query.or(anyFieldContains(searchable, search))
      }

      // Never unordered: the user's column or the model's default, then the key, so a page asked for
      // twice holds the same rows. See `listOrder`.
      query = withOrder(query, listOrder(sort ? [sort] : [], model.defaultSort, modelKeyColumns(model)))
      query = query.range(page * pageSize, (page + 1) * pageSize - 1)

      const result = await query
      if (result.error) {
        setError(result.error.message)
      } else {
        setRows((result.data ?? []).filter(isJsonObject))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
    }
  }, [client, model, searchable, search, sort, page])

  const freshness = useListFreshness(fetchData, { viewKey: `list.${model.name}` })
  const rowsFieldAccess = useRowsFieldAccess(model, rows, fieldAccess)
  // The column the rows are in order of, whether the user chose it or the model did.
  const shownSort = sort ?? model.defaultSort ?? null

  const columns = model.listColumns
    .map((name) => model.fields.find((f) => f.name === name))
    .filter((f): f is FieldConfig => f !== undefined)

  const toggleSort = (fieldName: string) => {
    setSort((prev) => {
      if (prev?.column === fieldName) {
        return prev.ascending ? { column: fieldName, ascending: false } : null
      }
      return { column: fieldName, ascending: true }
    })
  }

  // What each row on this page currently is. One query for the page, and a failure just means no
  // badges: the record's own editor is authoritative about its state.
  //
  // The state, not a boolean. This said "Draft" for any record with an unpublished edit, which is
  // wrong for the ordinary case of a published post being revised, and used the same word the
  // editor uses for a language that has never been published at all.
  const [recordStates, setRecordStates] = useState<Map<string, RecordState>>(new Map())
  const localeCodes = projectLocales.map((l) => l.code).join(",")
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const codes = localeCodes === "" ? [] : localeCodes.split(",")
      const publishable =
        model.versions === null ? [WHOLE_RECORD] : publishableLocales(model.versions, codes)
      const states = await fetchRecordStates(client, model, rows, publishable)
      if (!cancelled) setRecordStates(states)
    })()
    return () => {
      cancelled = true
    }
    // `localeCodes` is a joined string rather than the array, so a stable locale list does not
    // re-fire this on every render.
  }, [client, model, rows, localeCodes])

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

  // A refused row stays selected and the reason is shown: the client returns the error rather than
  // throwing, and ignoring it made a delete a policy or foreign key refused look like it worked.
  const handleBulkDelete = async () => {
    if (selected.size === 0) return
    const refused = await deleteRows(client, model, selected)
    setSelected(new Set(refused.keys()))
    setDeleteError(refusalMessage(refused, selected.size))
    freshness.refresh()
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
        {searchable.length > 0 && (
          <input
            type="search"
            className="st-search-input"
            placeholder={`Search ${model.labelPlural.toLowerCase()}...`}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          />
        )}

        <RefreshControls freshness={freshness} busy={loading} />

        {selected.size > 0 && (
          <div className="st-bulk-actions">
            <span>{selected.size} selected</span>
            {isOperationOffered(fieldAccess, model.tableName, "delete") && (
              <Button type="button" variant="destructive" onClick={() => { setConfirmingDelete(true) }}>
                Delete selected
              </Button>
            )}
          </div>
        )}
      </div>

      {error && <div className="st-error" role="alert">{error}</div>}
      {deleteError && <div className="st-error" role="alert">{deleteError}</div>}
      {confirmingDelete && (
        <Dialog
          role="alertdialog"
          title={`Delete ${selected.size} ${selected.size === 1 ? model.label : model.labelPlural}?`}
          actions={<DestructiveAnswers label="Delete" act={() => { void handleBulkDelete() }} onClose={() => { setConfirmingDelete(false) }} />}
        >
          <p>{selected.size === 1 ? "It is" : "They are"} deleted for good. This cannot be undone.</p>
        </Dialog>
      )}

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
                  {shownSort?.column === col.name && (
                    <span className="st-sort-indicator">
                      {shownSort.ascending ? " \u2191" : " \u2193"}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Only while there is nothing to show: a refresh keeps the rows on screen until the new
                ones arrive, rather than blanking the table every few seconds. */}
            {loading && rows.length === 0 ? (
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
                    {columns.map((col, index) => (
                      <td key={col.name} className="st-table-cell">
                        <AccessAwareCell
                          access={cellAccess(fieldAccess, model.tableName, col.name, row[col.name], rowsFieldAccess.get(id))}
                        >
                          <CellRenderer
                            value={row[col.name]}
                            field={col}
                            currentLocale={currentLocale}
                            defaultLocale={defaultLocale}
                          />
                        </AccessAwareCell>
                        {/* On the first column, so it reads as a property of the record rather than
                            of a field. An editor scanning a list needs to see that something is
                            waiting without opening every row to find out. */}
                        {index === 0 &&
                          (() => {
                            const state = recordStates.get(id)
                            // Live needs no badge: it is the state a reader would assume, and a
                            // badge on every row is a badge nobody reads.
                            if (state === undefined || state === "live") return null
                            const label = stateLabels[state]
                            return (
                              <Badge
                                variant={label.variant}
                                className="ml-2"
                                title={label.title}
                              >
                                {label.long}
                              </Badge>
                            )
                          })()}
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

/** Deletes each row by its key, and answers with the keys the server refused and why. */
async function deleteRows(
  client: SupatypeClient,
  model: ModelConfig,
  ids: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const refused = new Map<string, string>()
  for (const id of ids) {
    const { error } = await client.from(model.tableName).delete().eq(model.primaryKey, id)
    if (error) refused.set(id, error.message)
  }
  return refused
}

/** What to tell the user about a delete, or null when every row went. */
function refusalMessage(refused: ReadonlyMap<string, string>, asked: number): string | null {
  const [first] = refused.values()
  if (first === undefined) return null
  return `${refused.size} of ${asked} could not be deleted: ${first}`
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

  // A duration or a point, in the same words its edit widget uses.
  const readable = formatFieldValue(field, resolved)
  if (readable !== null) return <span className="st-cell-text">{readable}</span>
  // A key or a relation: its tail, with the whole id a hover or a copy away.
  if (isUuid(resolved)) return <span className="st-cell-text"><UuidCell value={resolved} /></span>
  return widgetCell(field.widget, resolved)
}

/** A value that is neither empty nor formatted for its field, as its widget shows it in a list. */
function widgetCell(widget: FieldConfig["widget"], resolved: unknown): React.ReactElement {
  switch (widget) {
    case "boolean":
      return <span className={`st-cell-bool st-cell-bool--${resolved ? "true" : "false"}`}>{resolved ? "Yes" : "No"}</span>
    case "image":
    case "file":
      if (typeof resolved === "object" && resolved !== null && "path" in resolved) {
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
  // `unknown` is restricted, empty, and per-row: this record either withholds the value or has
  // none, and nothing available here can tell which. Say that rather than pick one.
  if (access === "hidden" || access === "unknown") return <WithheldValue access={access} />

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
