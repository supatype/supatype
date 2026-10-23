import React, { useState, useEffect, useCallback, useMemo } from "react"
import { Header } from "../components/Header.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
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
  type StudioFieldAccess,
} from "../hooks/useStudioFieldAccess.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import { Badge, Button, Checkbox, DestructiveAnswers, Dialog, Input, SortTh, TableCard, Td, Th, tableRowClass, type SortDirection } from "../components/ui.js"
import type { SupatypeClient } from "@supatype/client"
import { anyFieldContains, searchColumns } from "../lib/postgrest-search.js"
import { formatFieldValue } from "../lib/field-display.js"
import { isUuid } from "../lib/uuid.js"
import { UuidCell } from "../components/UuidCell.js"
import { WithheldValue } from "../components/WithheldValue.js"
import { useRowsFieldAccess, type RowsFieldAccess } from "../hooks/useRecordAccess.js"
import {
  fetchRecordStates,
  publishableLocales,
  WHOLE_RECORD,
  type RecordState,
} from "../lib/publishing.js"
import { stateLabels } from "../components/PublishBar.js"
import { RefreshControls } from "../components/RefreshControls.js"
import { useListFreshness, type ListFreshness } from "../hooks/useListFreshness.js"
import { useContentWriteOffered } from "../hooks/useContentWriteOffered.js"
import { isPossiblyWithheld } from "../lib/field-access-layout.js"
import { listOrder, modelKeyColumns, withOrder, type ListOrder } from "../lib/list-order.js"
import { cn } from "../lib/utils.js"

interface ListViewProps {
  model: ModelConfig
  onNavigate: (path: string) => void
}

const PAGE_SIZE = 25

/** What the list asks the server for: the search text, the column order, and the page. */
interface ListQuery {
  search: string
  sort: ListOrder | null
  page: number
}

/** The page of rows the query asks for, kept on screen while the next read is in flight. */
interface ListRows {
  rows: Record<string, unknown>[]
  loading: boolean
  error: string | null
  /** The columns the last read said may be masked (X-Supatype-Masked-Fields). */
  maskedColumns: string[]
  fetchData: () => Promise<void>
}

/**
 * What the search box matches on: a localized field by its value in each locale, and no field
 * `ilike` cannot read, which failed the whole search. Keyed by the codes: the locale list can be a
 * fresh array each render, and a fresh list would refetch the rows on every one.
 */
function useSearchable(model: ModelConfig): ReturnType<typeof searchColumns> {
  const { defaultLocale, locales } = useLocale()
  const localeKey = defaultFirstLocales(defaultLocale, locales).join(",")
  return useMemo(
    () => searchColumns(model.fields, model.searchFields, localeKey.split(",")),
    [model.fields, model.searchFields, localeKey],
  )
}

function useListRows(model: ModelConfig, query: ListQuery, searchable: ReturnType<typeof searchColumns>): ListRows {
  const client = useAdminClient()
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [maskedColumns, setMaskedColumns] = useState<string[]>([])
  const { search, sort, page } = query

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      let read = client.from(model.tableName).select()
      // Every search field, on the server: it searched only the first.
      if (search && searchable.length > 0) read = read.or(anyFieldContains(searchable, search))
      // Never unordered: the chosen or default column, then the key, so a page reads the same twice.
      read = withOrder(read, listOrder(sort ? [sort] : [], model.defaultSort, modelKeyColumns(model)))
      const result = await read.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      if (result.error) setError(result.error.message)
      else { setRows((result.data ?? []).filter(isJsonObject)); setMaskedColumns((result.meta?.maskedFields ?? []).map((m) => m.column)) }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
    }
  }, [client, model, searchable, search, sort, page])

  return { rows, loading, error, maskedColumns, fetchData }
}

/**
 * What each row on this page currently is. One query for the page, and a failure just means no
 * badges: the record's own editor is authoritative about its state.
 *
 * The state, not a boolean. This said "Draft" for any record with an unpublished edit, which is
 * wrong for the ordinary case of a published post being revised, and used the same word the
 * editor uses for a language that has never been published at all.
 */
function useRecordStates(model: ModelConfig, rows: Record<string, unknown>[]): Map<string, RecordState> {
  const client = useAdminClient()
  const { locales } = useLocale()
  const [recordStates, setRecordStates] = useState<Map<string, RecordState>>(new Map())
  // A joined string rather than the array, so a stable locale list does not re-fire this on every render.
  const localeCodes = locales.map((l) => l.code).join(",")
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const codes = localeCodes === "" ? [] : localeCodes.split(",")
      const publishable = model.versions === null ? [WHOLE_RECORD] : publishableLocales(model.versions, codes)
      const states = await fetchRecordStates(client, model, rows, publishable)
      if (!cancelled) setRecordStates(states)
    })()
    return () => {
      cancelled = true
    }
  }, [client, model, rows, localeCodes])
  return recordStates
}

/** The rows ticked for a bulk action, by key. */
interface RowSelection {
  selected: Set<string>
  setSelected: (next: Set<string>) => void
  toggle: (id: string) => void
  toggleAll: () => void
}

function useRowSelection(rows: Record<string, unknown>[], primaryKey: string): RowSelection {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = (): void => {
    setSelected(selected.size === rows.length ? new Set() : new Set(rows.map((r) => String(r[primaryKey]))))
  }
  return { selected, setSelected, toggle, toggleAll }
}

/** The column the user sorts by: unsorted, then ascending, then descending, then unsorted again. */
function nextSort(prev: ListOrder | null, column: string): ListOrder | null {
  if (prev?.column !== column) return { column, ascending: true }
  return prev.ascending ? { column, ascending: false } : null
}

/** Asks before deleting the ticked rows, then deletes them; a refused row stays ticked with why. */
function useBulkDelete(model: ModelConfig, selection: RowSelection, freshness: ListFreshness): { error: string | null; run: () => Promise<void> } {
  const client = useAdminClient()
  // Its own state, not the read's error: the refetch after a delete clears that one before it starts.
  const [error, setError] = useState<string | null>(null)
  // A refused row stays selected and the reason is shown: the client returns the error rather than
  // throwing, and ignoring it made a delete a policy or foreign key refused look like it worked.
  const run = async (): Promise<void> => {
    const { selected, setSelected } = selection
    if (selected.size === 0) return
    const refused = await deleteRows(client, model, selected)
    setSelected(new Set(refused.keys()))
    setError(refusalMessage(refused, selected.size))
    freshness.refresh()
  }
  return { error, run }
}

export function ListView({ model, onNavigate }: ListViewProps): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()
  const [query, setQuery] = useState<ListQuery>({ search: "", sort: null, page: 0 })
  const searchable = useSearchable(model)
  const list = useListRows(model, query, searchable)
  const freshness = useListFreshness(list.fetchData, { viewKey: `list.${model.name}` })
  const selection = useRowSelection(list.rows, model.primaryKey)
  const bulkDelete = useBulkDelete(model, selection, freshness)

  return (
    <div>
      <ListHeader model={model} onNavigate={onNavigate} />
      <ListToolbar model={model} search={{ searchable: searchable.length > 0, text: query.search, set: (search) => { setQuery((q) => ({ ...q, search, page: 0 })) } }} state={{ freshness, loading: list.loading, selection, deleteRun: bulkDelete.run }} />
      {list.error && <div className="mb-4"><ErrorBanner message={list.error} /></div>}
      {bulkDelete.error && <div className="mb-4"><ErrorBanner message={bulkDelete.error} /></div>}
      <ListTable model={model} list={list} view={{ query, onSort: (column) => { setQuery((q) => ({ ...q, sort: nextSort(q.sort, column) })) }, selection, onNavigate }} />
      <ListPaging page={query.page} hasNext={list.rows.length >= PAGE_SIZE} onPage={(page) => { setQuery((q) => ({ ...q, page })) }} />
    </div>
  )
}

/** The model's name and, for a writer the server would let create one, Create. */
function ListHeader({ model, onNavigate }: ListViewProps): React.ReactElement {
  const fieldAccess = useStudioFieldAccess()
  // A viewer reads: no Create and no Delete selected, as the record editor offers them no Save.
  const canWrite = useContentWriteOffered()
  return (
    <Header
      title={model.labelPlural}
      actions={
        // Withdrawn only on a settled deny: `row` means some records allow it, and the
        // server is what refuses either way.
        canWrite && isOperationOffered(fieldAccess, model.tableName, "create") ? (
          <Button type="button" variant="primary" size="md" onClick={() => { onNavigate(`/models/${model.name}/create`) }}>
            Create {model.label}
          </Button>
        ) : null
      }
    />
  )
}

/** The search box, the refresh controls, and the bulk delete once rows are ticked. */
function ListToolbar({ model, search, state }: {
  model: ModelConfig
  search: { searchable: boolean; text: string; set: (text: string) => void }
  state: { freshness: ListFreshness; loading: boolean; selection: RowSelection; deleteRun: () => Promise<void> }
}): React.ReactElement {
  const { freshness, loading, selection } = state
  return (
    <div className="mb-4 flex flex-col items-stretch gap-2 md:flex-row md:items-center">
      {search.searchable && (
        <Input type="search" aria-label={`Search ${model.labelPlural}`} className="md:flex-1" placeholder={`Search ${model.labelPlural.toLowerCase()}...`} value={search.text} onChange={(e) => { search.set(e.target.value) }} />
      )}
      <RefreshControls freshness={freshness} busy={loading} />
      {selection.selected.size > 0 && <BulkActions model={model} selection={selection} onDelete={state.deleteRun} />}
    </div>
  )
}

/** "3 selected", and Delete selected for a writer allowed to delete, which asks first. */
function BulkActions({ model, selection, onDelete }: { model: ModelConfig; selection: RowSelection; onDelete: () => Promise<void> }): React.ReactElement {
  const fieldAccess = useStudioFieldAccess()
  const canWrite = useContentWriteOffered()
  const [confirming, setConfirming] = useState(false)
  const count = selection.selected.size
  return (
    <div className="flex items-center justify-end gap-2">
      <span>{count} selected</span>
      {canWrite && isOperationOffered(fieldAccess, model.tableName, "delete") && (
        <Button type="button" variant="destructive" onClick={() => { setConfirming(true) }}>
          Delete selected
        </Button>
      )}
      {confirming && (
        <Dialog
          role="alertdialog"
          title={`Delete ${count} ${count === 1 ? model.label : model.labelPlural}?`}
          actions={<DestructiveAnswers label="Delete" act={() => { void onDelete() }} onClose={() => { setConfirming(false) }} />}
        >
          <p>{count === 1 ? "It is" : "They are"} deleted for good. This cannot be undone.</p>
        </Dialog>
      )}
    </div>
  )
}

/** How a column header reads its sort: the direction when the rows are in its order, else none. */
function sortOf(shown: ListOrder | null, column: string): SortDirection {
  if (shown?.column !== column) return null
  return shown.ascending ? "ascending" : "descending"
}

/** What the table needs from the view around it: the query, sorting, ticking and opening rows. */
interface TableView {
  query: ListQuery
  onSort: (column: string) => void
  selection: RowSelection
  onNavigate: (path: string) => void
}

/** The header row: select-all, then a header per list column, sortable where the field is. */
function ListHead({ model, columns, view, rowCount }: { model: ModelConfig; columns: FieldConfig[]; view: TableView; rowCount: number }): React.ReactElement {
  // The column the rows are in order of, whether the user chose it or the model did.
  const shownSort = view.query.sort ?? model.defaultSort ?? null
  const { selected, toggleAll } = view.selection
  return (
    <>
      <Th className="w-10 text-center">
        <Checkbox label={null} checked={rowCount > 0 && selected.size === rowCount} onChange={toggleAll} aria-label="Select all" />
      </Th>
      {columns.map((col) => {
        const width = col.listWidth ? { width: col.listWidth } : undefined
        return col.sortable !== false
          ? <SortTh key={col.name} sort={sortOf(shownSort, col.name)} onSort={() => { view.onSort(col.name) }} style={width}>{col.label}</SortTh>
          : <Th key={col.name} style={width}>{col.label}</Th>
      })}
    </>
  )
}

function ListTable({ model, list, view }: { model: ModelConfig; list: ListRows; view: TableView }): React.ReactElement {
  const columns = model.listColumns
    .map((name) => model.fields.find((f) => f.name === name))
    .filter((f): f is FieldConfig => f !== undefined)
  const recordStates = useRecordStates(model, list.rows)
  const fieldAccess = useStudioFieldAccess()
  const rowsFieldAccess = useRowsFieldAccess(model, list.rows, fieldAccess)
  // With no field access answer, a null in a column the read says may be masked is not shown as empty.
  const maskable = fieldAccess.unavailable === true ? list.maskedColumns : []
  const access = { fieldAccess, rowsFieldAccess, maskable }
  const span = columns.length + 1

  return (
    <TableCard head={<ListHead model={model} columns={columns} view={view} rowCount={list.rows.length} />}>
      {/* Only while there is nothing to show: a refresh keeps the rows on screen until the new
          ones arrive, rather than blanking the table every few seconds. */}
      {list.loading && list.rows.length === 0 ? (
        <NoticeRow span={span}>Loading...</NoticeRow>
      ) : list.rows.length === 0 ? (
        <NoticeRow span={span}>No {model.labelPlural.toLowerCase()} found.</NoticeRow>
      ) : (
        list.rows.map((row) => {
          const id = String(row[model.primaryKey])
          return <ListRow key={id} record={{ id, row, state: recordStates.get(id) }} table={{ model, columns, access }} view={view} />
        })
      )}
    </TableCard>
  )
}

/** A row standing in for the rows while there are none to show: loading, or nothing found. */
function NoticeRow({ span, children }: { span: number; children: React.ReactNode }): React.ReactElement {
  return (
    <tr>
      <Td colSpan={span} className="py-8 text-center text-muted-foreground">{children}</Td>
    </tr>
  )
}

/** What decides whether a cell shows its value or a padlock. */
interface ListAccess {
  fieldAccess: StudioFieldAccess
  rowsFieldAccess: RowsFieldAccess
  maskable: string[]
}

/**
 * One record. A click anywhere but its tick box opens it, and so does Enter while the row has focus,
 * so the list can be worked from the keyboard.
 */
function ListRow({ record, table, view }: {
  record: { id: string; row: Record<string, unknown>; state: RecordState | undefined }
  table: { model: ModelConfig; columns: FieldConfig[]; access: ListAccess }
  view: TableView
}): React.ReactElement {
  const { id } = record
  const { model, columns } = table
  const { selection } = view
  const open = (): void => { view.onNavigate(`/models/${model.name}/${id}`) }
  return (
    <tr
      tabIndex={0}
      className={cn(tableRowClass(true), "focus-visible:outline-none focus-visible:bg-muted/30", selection.selected.has(id) && "bg-primary/5")}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) open() }}
    >
      <Td className="w-10 text-center" onClick={(e) => { e.stopPropagation() }}>
        <Checkbox label={null} checked={selection.selected.has(id)} onChange={() => { selection.toggle(id) }} aria-label={`Select row ${id}`} />
      </Td>
      {columns.map((col, index) => (
        <Td key={col.name}>
          <ListCell field={col} row={record.row} table={table} recordId={id} />
          {index === 0 && <StateBadge state={record.state} />}
        </Td>
      ))}
    </tr>
  )
}

/** A cell's value as its field shows it in a list, or the padlock where access withholds it. */
function ListCell({ field, row, table, recordId }: {
  field: FieldConfig
  row: Record<string, unknown>
  table: { model: ModelConfig; access: ListAccess }
  recordId: string
}): React.ReactElement {
  const { currentLocale, defaultLocale } = useLocale()
  const { model, access } = table
  const value = row[field.name]
  const cell = isPossiblyWithheld(access.maskable, field.name, value)
    ? "unknown"
    : cellAccess(access.fieldAccess, model.tableName, field.name, value, access.rowsFieldAccess.get(recordId))
  return (
    <AccessAwareCell access={cell}>
      <CellRenderer value={value} field={field} locale={{ currentLocale, defaultLocale }} />
    </AccessAwareCell>
  )
}

/**
 * On the first column, so it reads as a property of the record rather than of a field. An editor
 * scanning a list needs to see that something is waiting without opening every row to find out.
 * Live needs no badge: it is the state a reader would assume, and a badge on every row is a badge
 * nobody reads.
 */
function StateBadge({ state }: { state: RecordState | undefined }): React.ReactElement | null {
  if (state === undefined || state === "live") return null
  const label = stateLabels[state]
  return (
    <Badge variant={label.variant} className="ml-2" title={label.title}>
      {label.long}
    </Badge>
  )
}

/** Previous and Next, and the page number. Next waits for a full page, as there is no total. */
function ListPaging({ page, hasNext, onPage }: { page: number; hasNext: boolean; onPage: (page: number) => void }): React.ReactElement {
  return (
    <div className="mt-4 flex items-center justify-center gap-2 md:justify-end">
      <Button type="button" size="md" disabled={page === 0} onClick={() => { onPage(Math.max(0, page - 1)) }}>
        Previous
      </Button>
      <span className="text-[0.8rem] text-muted-foreground">Page {page + 1}</span>
      <Button type="button" size="md" disabled={!hasNext} onClick={() => { onPage(page + 1) }}>
        Next
      </Button>
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

const MUTED = "text-muted-foreground"

function CellRenderer({
  value,
  field,
  locale,
}: {
  value: unknown
  field: FieldConfig
  locale: { currentLocale: string; defaultLocale: string }
}): React.ReactElement {
  const resolved = getLocalizedFieldValue(value, field.localized === true, locale.currentLocale, locale.defaultLocale)

  if (resolved === null || resolved === undefined) {
    return <span className={MUTED}>-</span>
  }

  // A duration or a point, in the same words its edit widget uses.
  const readable = formatFieldValue(field, resolved)
  if (readable !== null) return <span>{readable}</span>
  // A key or a relation: its tail, with the whole id a hover or a copy away.
  if (isUuid(resolved)) return <span><UuidCell value={resolved} /></span>
  return widgetCell(field.widget, resolved)
}

/** A value that is neither empty nor formatted for its field, as its widget shows it in a list. */
function widgetCell(widget: FieldConfig["widget"], resolved: unknown): React.ReactElement {
  switch (widget) {
    case "boolean":
      return <span>{resolved ? "Yes" : "No"}</span>
    case "image":
    case "file":
      if (typeof resolved === "object" && resolved !== null && "path" in resolved) {
        return <span className="text-[0.8rem] text-primary">[Image]</span>
      }
      return <span>{formatCellText(resolved)}</span>
    case "publish":
      return <span>{String(resolved)}</span>
    case "date":
    case "datetime":
      return <span className={MUTED}>{new Date(String(resolved)).toLocaleDateString()}</span>
    default:
      return <span>{truncate(formatCellText(resolved), 100)}</span>
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
      <span>
        {children}
        <span
          className="ml-1"
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
