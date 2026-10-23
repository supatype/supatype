import React, { useState, useEffect, useCallback, useId, useRef } from "react"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { FieldWidget } from "./FieldWidget.js"
import { SlidePanel } from "../components/SlidePanel.js"
import { Avatar, Button, ButtonLink, CodeBlock, FieldFrame, IconButton, Input, ListButton, Popover, TextLink } from "../components/ui.js"
import { IconCheck, IconChevronDown, IconEye, IconX } from "../components/icons.js"
import { cn } from "../lib/utils.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { bodyMessage, isJsonObject, readJsonObject } from "../lib/json.js"
import { stringOption } from "./field-options.js"
import type { WidgetProps } from "./FieldWidget.js"
import type { ModelConfig } from "../config.js"
import { containsPattern } from "../lib/postgrest-search.js"
import type { SupatypeClient } from "@supatype/client"
import {
  fetchAuthUserById,
  fetchAuthUsersByIds,
  inferAuthUserRelation,
  relationDisplayFromAuthUser,
  SYSTEM_AUTH_USER,
  searchAuthUsers,
  type AuthUserSummary,
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

/** The REST address of `table`, every column, with `params` as its query. */
function restUrl(client: SupatypeClient, table: string, params: Record<string, string>): URL {
  const url = new URL(`${client.url}/rest/v1/${table}`)
  url.searchParams.set("select", "*")
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url
}

async function postgrestQuery(
  client: SupatypeClient,
  table: string,
  schema: string | undefined,
  params: Record<string, string>,
): Promise<{ data: Record<string, unknown>[]; error: { message: string } | null }> {
  const url = restUrl(client, table, params)
  // The signed-in user's token, proxied: the server decides whether this reads
  // as them or elevated. Sending a service role key from the browser would skip
  // that decision entirely.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...studioAuthHeaders(client),
    ...(schema ? { "Accept-Profile": schema } : {}),
  }
  try {
    const res = await fetch(url.toString(), { headers, credentials: "include" })
    if (!res.ok) {
      const err = await readJsonObject(res)
      return { data: [], error: { message: bodyMessage(err) ?? `HTTP ${res.status}` } }
    }
    const rows = await res.json()
    return { data: Array.isArray(rows) ? rows.filter(isJsonObject) : [], error: null }
  } catch (e) {
    return { data: [], error: { message: e instanceof Error ? e.message : "Network error" } }
  }
}

function rowToOption(row: Record<string, unknown>, displayField: string): RelationOption {
  const id = String(row["id"] ?? row[Object.keys(row)[0]!] ?? "")
  const label = String(row[displayField] ?? row["name"] ?? row["title"] ?? row["email"] ?? id)
  return { id, label, initials: initialsFromLabel(label) }
}

// ─── Options, a page at a time ───────────────────────────────────────────────

/** Options per page of the picker. */
const RELATION_PAGE_SIZE = 30

/** One page of options, and whether the server holds more after it. */
interface OptionPage {
  items: RelationOption[]
  more: boolean
}

function authUserOption(user: AuthUserSummary): RelationOption {
  const display = relationDisplayFromAuthUser(user)
  return { id: user.id, label: display.label, initials: display.initials, ...(display.sublabel !== undefined && { sublabel: display.sublabel }) }
}

function optionDisplay(opt: RelationOption): RelationDisplay {
  return { label: opt.label, initials: opt.initials, ...(opt.sublabel !== undefined && { sublabel: opt.sublabel }) }
}

/** Users matching `term`, searched by the auth server, so any user can be picked. */
async function authUserOptions(client: SupatypeClient, term: string, page: number): Promise<OptionPage> {
  const { users, total } = await searchAuthUsers(client, term, { page, perPage: RELATION_PAGE_SIZE })
  return { items: users.map(authUserOption), more: page * RELATION_PAGE_SIZE + users.length < total }
}

/**
 * The column a picker pages a table in order of, so an offset means the same rows on every request:
 * the primary key of the model the table belongs to. A table no model describes has no key Studio
 * knows, so it pages by `ctid`, the row's physical position. That holds while the rows stay put:
 * an update or a vacuum can move a row, so a picker open across such a change may show one twice or
 * miss one, which is the most a table without a known key allows. It is still better than no order,
 * where Postgres may answer any rows for any offset.
 */
function recordOrderKey(models: readonly ModelConfig[], table: string): string {
  return models.find((m) => m.tableName === table || m.name === table)?.primaryKey ?? "ctid"
}

/** Where the picker reads its records: the table, its schema, the column it shows, and its order. */
interface RecordSource {
  table: string
  schema: string | undefined
  displayField: string
  orderKey: string
}

/** Rows of `source.table` whose display field holds `term`; a full page means there may be more. */
async function recordOptions(client: SupatypeClient, source: RecordSource, term: string, page: number): Promise<OptionPage> {
  const params: Record<string, string> = {
    limit: String(RELATION_PAGE_SIZE),
    offset: String(page * RELATION_PAGE_SIZE),
    order: `${source.orderKey}.asc`,
  }
  if (term) params[source.displayField] = `ilike.${containsPattern(term)}`
  const result = await postgrestQuery(client, source.table, source.schema, params)
  if (result.error) return { items: [], more: false }
  const items = result.data.map((row) => rowToOption(row, source.displayField))
  return { items, more: items.length === RELATION_PAGE_SIZE }
}

// ─── Auth user preview ────────────────────────────────────────────────────────

const PREVIEW_NOTE = "py-1 text-[0.8rem] text-muted-foreground"
const PREVIEW_ERROR = "text-[0.8rem] text-destructive-text"

/** One fact about a user: its name above, its value under. */
function UserFact({ term, children, mono = false }: { term: string; children: React.ReactNode; mono?: boolean }): React.ReactElement {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[0.68rem] uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className={mono ? "break-all font-mono text-xs text-muted-foreground" : "text-[0.85rem] text-foreground"}>{children}</dd>
    </div>
  )
}

/** The user, loaded by id: `null` until it arrives, with why it could not be when it could not. */
function useAuthUser(userId: string): { user: Awaited<ReturnType<typeof fetchAuthUserById>>; loading: boolean; error: string | null } {
  const client = useAdminClient()
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

  return { user, loading, error }
}

function AuthUserPreview({
  userId,
  onNavigateAway,
}: {
  userId: string
  onNavigateAway?: () => void
}): React.ReactElement {
  const { user, loading, error } = useAuthUser(userId)

  if (loading) return <div className={PREVIEW_NOTE}>Loading user…</div>
  if (error || !user) return <div className={PREVIEW_ERROR}>{error ?? "User not found"}</div>

  const display = relationDisplayFromAuthUser(user)
  return (
    <div className="flex flex-col gap-3">
      <span className="mb-4 flex min-w-0 flex-1 items-center gap-2">
        <Avatar initials={display.initials} size="lg" />
        <ChipText display={display} />
      </span>
      <dl className="m-0 grid gap-2.5">
        <UserFact term="User ID" mono>{user.id}</UserFact>
        {user.email && <UserFact term="Email">{user.email}</UserFact>}
        {user.name && <UserFact term="Name">{user.name}</UserFact>}
      </dl>
      <ButtonLink size="xs" className="self-start" to={`/authentication/users?user=${encodeURIComponent(user.id)}`} onClick={() => { onNavigateAway?.() }}>
        Open in Users
      </ButtonLink>
    </div>
  )
}

// ─── Related record preview (rendered inside the slideover) ───────────────────

/** The record, loaded by its key: `null` until it arrives or when there is none. */
function useRelatedRecord(target: string, recordId: string, model: ModelConfig | undefined): { record: Record<string, unknown> | null; loading: boolean; error: string | null } {
  const client = useAdminClient()
  const [record, setRecord] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { table, schema } = resolveTarget(target, false)

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
  }, [target, recordId])

  return { record, loading, error }
}

function ModelRelationPreview({ target, recordId }: { target: string; recordId: string }): React.ReactElement {
  const config = useAdminConfig()
  const model = config.models.find((m) => m.tableName === resolveTarget(target, false).table)
  const { record, loading, error } = useRelatedRecord(target, recordId, model)

  if (loading) return <div className={PREVIEW_NOTE}>Loading…</div>
  if (error) return <div className={PREVIEW_ERROR}>{error}</div>
  if (!record) return <div className={PREVIEW_NOTE}>Record not found</div>

  if (model) {
    const fields = model.fields.filter((f) => !f.hidden && f.widget !== "blocks")
    return (
      <div className="flex flex-col">
        {fields.map((f) => (
          <FieldWidget key={f.name} config={f} value={record[f.name]} onChange={() => {}} readOnly />
        ))}
      </div>
    )
  }

  return <CodeBlock className="whitespace-pre-wrap border-0 bg-transparent p-0 text-[0.72rem] leading-normal text-muted-foreground">{JSON.stringify(record, null, 2)}</CodeBlock>
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

const ELLIPSIS = "overflow-hidden text-ellipsis whitespace-nowrap leading-tight"

/** A record's label, and the line under it when it has one. */
function ChipText({ display, loading = false }: { display: RelationDisplay; loading?: boolean }): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className={cn(ELLIPSIS, "text-[0.85rem]", loading ? "italic text-muted-foreground" : "text-foreground")}>
        {loading ? "Loading…" : display.label}
      </span>
      {!loading && display.sublabel && <span className={cn(ELLIPSIS, "text-[0.72rem] text-muted-foreground")}>{display.sublabel}</span>}
    </span>
  )
}

function RelationChip({ display, loading }: { display: RelationDisplay; loading?: boolean }): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Avatar initials={display.initials} />
      <ChipText display={display} {...(loading !== undefined && { loading })} />
    </span>
  )
}

/**
 * One option in the picker's listbox. Named by its label alone, so a screen reader reads the
 * record's name rather than its avatar initials and truncated key as well.
 */
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
  const labelId = `${useId()}-label`
  return (
    <ListButton role="option" aria-selected={selected} aria-labelledby={labelId} className={cn("px-2 py-1.5 text-[0.8rem] text-foreground", selected && "bg-primary/10 font-normal")} onClick={onSelect}>
      <Avatar initials={opt.initials} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span id={labelId} className={ELLIPSIS}>{opt.label}</span>
        {opt.sublabel && <span className={cn(ELLIPSIS, "text-[0.72rem] text-muted-foreground")}>{opt.sublabel}</span>}
      </span>
      {!isAuthUser && <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">{truncateId(opt.id)}</span>}
      {selected && <span className="shrink-0 text-primary"><IconCheck /></span>}
    </ListButton>
  )
}

// ─── The picker's state ───────────────────────────────────────────────────────

/** Where a relation field's records come from, and how the picker searches and labels them. */
interface RelationTarget {
  rawTarget: string
  isAuthUser: boolean
  source: RecordSource
  isMulti: boolean
  searchPlaceholder: string
}

function useRelationTarget(config: WidgetProps["config"]): RelationTarget {
  const rawTarget = stringOption(config, "target") ?? ""
  const isAuthUser = inferAuthUserRelation(rawTarget, config.name, config.label)
  const { table, schema } = resolveTarget(rawTarget, isAuthUser)
  const orderKey = recordOrderKey(useAdminConfig().models, table)
  const displayField = stringOption(config, "displayField") ?? (isAuthUser ? "email" : "name")
  return {
    rawTarget,
    isAuthUser,
    source: { table, schema, displayField, orderKey },
    isMulti: config.widget === "multirelation",
    searchPlaceholder: isAuthUser ? "Search by email or name…" : `Search ${config.label.toLowerCase()}…`,
  }
}

/** How each picked or listed record reads, by id, and the ids still being looked up. */
interface RelationDisplays {
  displayMap: Record<string, RelationDisplay>
  resolvingIds: Set<string>
  mergeDisplay: (entries: Record<string, RelationDisplay>) => void
}

function useRelationDisplays(): RelationDisplays & { setResolvingIds: React.Dispatch<React.SetStateAction<Set<string>>> } {
  const [displayMap, setDisplayMap] = useState<Record<string, RelationDisplay>>({})
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set())
  const mergeDisplay = useCallback((entries: Record<string, RelationDisplay>) => {
    setDisplayMap((prev) => ({ ...prev, ...entries }))
  }, [])
  return { displayMap, resolvingIds, mergeDisplay, setResolvingIds }
}

/** The labels of picked records the picker has not listed yet, read by id. */
async function resolveDisplays(client: SupatypeClient, target: RelationTarget, ids: string[]): Promise<Record<string, RelationDisplay>> {
  if (target.isAuthUser) return Object.fromEntries(await fetchAuthUsersByIds(client, ids))
  if (!target.source.table) return {}
  const result = await postgrestQuery(client, target.source.table, target.source.schema, { id: `in.(${ids.join(",")})` })
  if (result.error || !result.data) return {}
  const entries: Record<string, RelationDisplay> = {}
  result.data.forEach((row) => {
    const opt = rowToOption(row, target.source.displayField)
    entries[opt.id] = { label: opt.label, initials: opt.initials }
  })
  return entries
}

/** Looks up the label of every picked id the picker has not shown yet, whenever the picked ids change. */
function useResolvedSelection(target: RelationTarget, selectedIds: string[], displays: ReturnType<typeof useRelationDisplays>): void {
  const client = useAdminClient()
  const { displayMap, mergeDisplay, setResolvingIds } = displays
  const selectedKey = selectedIds.join(",")
  useEffect(() => {
    const unresolved = selectedIds.filter((id) => id && !displayMap[id])
    if (!unresolved.length) return

    setResolvingIds((prev) => new Set([...prev, ...unresolved]))
    void (async () => {
      try {
        mergeDisplay(await resolveDisplays(client, target, unresolved))
      } finally {
        setResolvingIds((prev) => {
          const next = new Set(prev)
          unresolved.forEach((id) => next.delete(id))
          return next
        })
      }
    })()
  }, [selectedKey, target.source.table, target.source.schema, target.source.displayField, target.isAuthUser])
}

/** The options listed for the search, a page at a time, and how to ask for the next page. */
interface RelationOptions {
  options: RelationOption[]
  more: boolean
  loading: boolean
  loadMore: () => void
}

function useRelationOptions(target: RelationTarget, search: { open: boolean; term: string }, mergeDisplay: RelationDisplays["mergeDisplay"]): RelationOptions {
  const client = useAdminClient()
  const [options, setOptions] = useState<RelationOption[]>([])
  const [optionsAt, setOptionsAt] = useState({ page: 0, more: false })
  const [loading, setLoading] = useState(false)
  const { isAuthUser, source } = target

  /** Page `page` of the options matching `term`: the first replaces the list, later ones extend it. */
  const fetchOptions = useCallback(async (term: string, page: number) => {
    if (!source.table && !isAuthUser) return
    // Only a new search blanks the list; loading more keeps what is shown.
    if (page === 0) setLoading(true)
    try {
      const next = isAuthUser ? await authUserOptions(client, term, page) : await recordOptions(client, source, term, page)
      setOptions((prev) => (page === 0 ? next.items : [...prev, ...next.items]))
      setOptionsAt({ page, more: next.more })
      mergeDisplay(Object.fromEntries(next.items.map((o) => [o.id, optionDisplay(o)])))
    } finally {
      setLoading(false)
    }
  }, [client, source.table, source.schema, source.displayField, source.orderKey, isAuthUser, mergeDisplay])

  useEffect(() => {
    if (!search.open) return
    const t = setTimeout(() => { void fetchOptions(search.term, 0) }, search.term ? 200 : 0)
    return () => clearTimeout(t)
  }, [search.open, search.term, fetchOptions])

  return { options, more: optionsAt.more, loading, loadMore: () => { void fetchOptions(search.term, optionsAt.page + 1) } }
}

/** Whether the picker is open, what is typed in its search, and the elements it moves focus between. */
interface PickerState {
  open: boolean
  term: string
  setTerm: (term: string) => void
  openPicker: () => void
  closePicker: () => void
  pickerRef: React.RefObject<HTMLDivElement | null>
  searchRef: React.RefObject<HTMLInputElement | null>
  triggerRef: React.RefObject<HTMLElement | null>
  /** Escape closes the picker and puts focus back on what opened it. */
  onKeyDown: (e: React.KeyboardEvent) => void
}

/** Focuses the search as the picker opens, and the trigger after Escape closes it. */
function usePickerFocus(open: boolean, refs: { searchRef: React.RefObject<HTMLInputElement | null>; triggerRef: React.RefObject<HTMLElement | null> }, returnFocus: React.RefObject<boolean>): void {
  useEffect(() => {
    if (open) {
      setTimeout(() => refs.searchRef.current?.focus(), 40)
    } else if (returnFocus.current) {
      returnFocus.current = false
      refs.triggerRef.current?.focus()
    }
  }, [open])
}

/** Closes the picker on a mouse press anywhere outside it. */
function useClickAway(open: boolean, pickerRef: React.RefObject<HTMLDivElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const clicked = e.target
      if (pickerRef.current && !(clicked instanceof Node && pickerRef.current.contains(clicked))) close()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])
}

function usePicker(readOnly: boolean): PickerState {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState("")
  const pickerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLElement>(null)
  const returnFocus = useRef(false)
  const closePicker = (): void => { setOpen(false); setTerm("") }
  const openPicker = (): void => { if (!readOnly) { setOpen(true); setTerm("") } }
  usePickerFocus(open, { searchRef, triggerRef }, returnFocus)
  useClickAway(open, pickerRef, closePicker)
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "Escape" || !open) return
    e.preventDefault()
    e.stopPropagation()
    returnFocus.current = true
    closePicker()
  }
  return { open, term, setTerm, openPicker, closePicker, pickerRef, searchRef, triggerRef, onKeyDown }
}

// ─── The picker's parts ───────────────────────────────────────────────────────

/** What is picked and how to change it. */
interface Selection {
  ids: string[]
  select: (id: string) => void
  remove: (id: string) => void
  view: (id: string) => void
  displayFor: (id: string) => RelationDisplay
  resolving: Set<string>
}

/** The options, the search above them unless the trigger is the search, and Load more. */
function RelationDropdown({ field, picker, list }: {
  field: { label: string; target: RelationTarget; selection: Selection; inlineSearch: boolean }
  picker: PickerState
  list: RelationOptions
}): React.ReactElement {
  const { label, target, selection, inlineSearch } = field
  return (
    <Popover>
      {!inlineSearch && (
        <Input ref={picker.searchRef} type="search" className="mb-1.5 px-2 py-1 text-xs" aria-label={`Search ${label}`} placeholder={target.searchPlaceholder} value={picker.term} onChange={(e) => picker.setTerm(e.target.value)} autoComplete="off" />
      )}
      {list.loading ? (
        <div className="p-2 text-center text-[0.8rem] text-muted-foreground">Searching…</div>
      ) : (
        <div className="max-h-60 overflow-y-auto">
          <div role="listbox" aria-label={`${label} options`} aria-multiselectable={target.isMulti || undefined}>
            {list.options.map((opt) => (
              <RelationOptionRow key={opt.id} opt={opt} selected={selection.ids.includes(opt.id)} isAuthUser={target.isAuthUser} onSelect={() => selection.select(opt.id)} />
            ))}
          </div>
          {list.more && <ListButton className="px-2 py-1.5 text-[0.72rem]" onClick={list.loadMore}>Load more</ListButton>}
          {list.options.length === 0 && (
            <div className="p-2 text-center text-[0.8rem] text-muted-foreground">{picker.term ? `No results for "${picker.term}"` : "No records found"}</div>
          )}
        </div>
      )}
    </Popover>
  )
}

/** What a picked record's actions act on: the field's target, its picks, and whether it is read only. */
interface PickedField {
  target: RelationTarget
  selection: Selection
  readOnly: boolean
}

/**
 * View, and unless read only Remove, beside a picked record. A many-relation's tag offers View then
 * Remove; the single picker offers Clear then View, Clear sitting where the value does.
 */
function PickedActions({ id, field, single }: { id: string; field: PickedField; single: boolean }): React.ReactElement {
  const { target, selection, readOnly } = field
  const view = <IconButton label={target.isAuthUser ? "View user" : "View record"} className="h-6 w-6" onClick={(e) => { e.stopPropagation(); selection.view(id) }}><IconEye size={12} /></IconButton>
  const remove = readOnly ? null : (
    <IconButton label={single ? "Clear" : "Remove"} className="h-6 w-6 hover:text-destructive-text" onClick={(e) => { e.stopPropagation(); selection.remove(id) }}><IconX size={12} /></IconButton>
  )
  return single ? <>{remove}{view}</> : <>{view}{remove}</>
}

/** A many-relation: the picked records as tags, and Add… to open the picker under them. */
function MultiRelation({ field, picker, list }: {
  field: { label: string; target: RelationTarget; selection: Selection; readOnly: boolean }
  picker: PickerState
  list: RelationOptions
}): React.ReactElement {
  const { selection, readOnly } = field
  return (
    <>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        {selection.ids.length > 0 ? selection.ids.map((id) => (
          <span key={id} className="inline-flex max-w-80 items-center gap-1.5 rounded-lg border border-border bg-secondary py-1 pl-2 pr-1.5 text-[0.8rem] text-foreground">
            <RelationChip display={selection.displayFor(id)} loading={selection.resolving.has(id)} />
            <PickedActions id={id} field={field} single={false} />
          </span>
        )) : (
          <span className="text-[0.8rem] text-muted-foreground">None selected</span>
        )}
      </div>
      {!readOnly && (
        <div className="relative" ref={picker.pickerRef} onKeyDown={picker.onKeyDown}>
          <Button type="button" size="xs" ref={(el: HTMLButtonElement | null) => { picker.triggerRef.current = el }} onClick={() => picker.open ? picker.closePicker() : picker.openPicker()}>
            {picker.open ? "Close" : "Add…"}
          </Button>
          {picker.open && <RelationDropdown field={{ ...field, inlineSearch: false }} picker={picker} list={list} />}
        </div>
      )}
    </>
  )
}

/** The open single picker's trigger: the search itself, with a button that closes it. */
function OpenTrigger({ label, target, picker }: { label: string; target: RelationTarget; picker: PickerState }): React.ReactElement {
  return (
    <FieldFrame className="min-h-9 border-ring py-1 pl-3 pr-2 ring-2 ring-ring/20">
      <Input ref={picker.searchRef} type="search" className="min-w-0 flex-1 border-0 bg-transparent p-0 focus:ring-0" placeholder={target.searchPlaceholder} value={picker.term} onChange={(e) => picker.setTerm(e.target.value)} autoComplete="off" aria-label={label} />
      <IconButton label="Close" className="h-6 w-6" onClick={picker.closePicker}><span className="rotate-180"><IconChevronDown size={12} /></span></IconButton>
    </FieldFrame>
  )
}

/** The picked record as a link that views it, or the search prompt while nothing is picked. */
function PickedValue({ target, selection }: { target: RelationTarget; selection: Selection }): React.ReactElement {
  const picked = selection.ids[0]
  if (!picked) return <span className="flex-1 text-[0.85rem] text-muted-foreground">{target.searchPlaceholder}</span>
  return (
    <TextLink tone="muted" title={target.isAuthUser ? "View user" : "View record"} className="min-w-0 flex-1 text-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); selection.view(picked) }}>
      <RelationChip display={selection.displayFor(picked)} loading={selection.resolving.has(picked)} />
    </TextLink>
  )
}

/** A combobox that opens on a click, Enter or Space, unless read only, when it takes no focus. */
function comboboxProps(picker: PickerState, readOnly: boolean): Pick<React.HTMLAttributes<HTMLDivElement>, "onClick" | "onKeyDown" | "role" | "aria-expanded" | "aria-haspopup" | "tabIndex"> {
  return {
    onClick: () => { if (!readOnly) picker.openPicker() },
    onKeyDown: (e) => {
      if (readOnly || (e.key !== "Enter" && e.key !== " ")) return
      e.preventDefault()
      picker.openPicker()
    },
    role: "combobox",
    "aria-expanded": false,
    "aria-haspopup": "listbox",
    tabIndex: readOnly ? -1 : 0,
  }
}

/** The closed single picker: the picked record (or a prompt), its actions, and a click to open. */
function ClosedTrigger({ field, picker }: {
  field: { target: RelationTarget; selection: Selection; readOnly: boolean }
  picker: PickerState
}): React.ReactElement {
  const { target, selection, readOnly } = field
  const picked = selection.ids[0]
  return (
    <FieldFrame
      ref={(el: HTMLDivElement | null) => { picker.triggerRef.current = el }}
      className={cn("min-h-9 py-1 pl-3 pr-2", readOnly ? "cursor-default" : "cursor-pointer hover:border-ring")}
      {...comboboxProps(picker, readOnly)}
    >
      <PickedValue target={target} selection={selection} />
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {picked && <PickedActions id={picked} field={field} single />}
        {!readOnly && <span className="text-muted-foreground"><IconChevronDown size={12} /></span>}
      </div>
    </FieldFrame>
  )
}

/** A single relation: a combobox that shows the picked record and turns into a search when opened. */
function SingleRelation({ field, picker, list }: {
  field: { label: string; target: RelationTarget; selection: Selection; readOnly: boolean }
  picker: PickerState
  list: RelationOptions
}): React.ReactElement {
  return (
    <div className="relative w-full" ref={picker.pickerRef} onKeyDown={picker.onKeyDown}>
      {picker.open && !field.readOnly ? (
        <>
          <OpenTrigger label={field.label} target={field.target} picker={picker} />
          <RelationDropdown field={{ ...field, inlineSearch: true }} picker={picker} list={list} />
        </>
      ) : (
        <ClosedTrigger field={field} picker={picker} />
      )}
    </div>
  )
}

// ─── RelationWidget ───────────────────────────────────────────────────────────

/** The picked ids as strings: every id of a many-relation, or the one id of a single one. */
function selectedIdsOf(value: unknown, isMulti: boolean): string[] {
  if (isMulti) return Array.isArray(value) ? value.map((id) => String(id)) : []
  return value ? [String(value)] : []
}

/** Picking, removing and viewing records, and how each picked one reads. */
function useSelection(props: WidgetProps, target: RelationTarget, ctx: { picker: PickerState; displays: RelationDisplays; view: (id: string) => void }): Selection {
  const { value, onChange } = props
  const { picker, displays, view } = ctx
  const ids = selectedIdsOf(value, target.isMulti)
  return {
    ids,
    select: (id) => {
      if (target.isMulti) {
        onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
      } else {
        onChange(id)
        picker.closePicker()
      }
    },
    remove: (id) => { onChange(target.isMulti ? ids.filter((x) => x !== id) : null) },
    view,
    displayFor: (id) => {
      if (displays.displayMap[id]) return displays.displayMap[id]!
      if (displays.resolvingIds.has(id)) return { label: "Loading…", initials: "…" }
      return { label: target.isAuthUser ? "Unknown user" : truncateId(id), initials: "?" }
    },
    resolving: displays.resolvingIds,
  }
}

export function RelationWidget(props: WidgetProps): React.ReactElement {
  const { config, readOnly } = props
  const target = useRelationTarget(config)
  const picker = usePicker(readOnly)
  const displays = useRelationDisplays()
  const list = useRelationOptions(target, { open: picker.open, term: picker.term }, displays.mergeDisplay)
  const [slideoverId, setSlideoverId] = useState<string | null>(null)
  const selection = useSelection(props, target, { picker, displays, view: setSlideoverId })
  useResolvedSelection(target, selection.ids, displays)
  const field = { label: config.label, target, selection, readOnly }
  const slideoverTitle = slideoverId ? `${config.label}: ${displays.displayMap[slideoverId]?.label ?? slideoverId}` : config.label

  return (
    <div className="flex flex-col gap-2">
      {target.isMulti ? <MultiRelation field={field} picker={picker} list={list} /> : <SingleRelation field={field} picker={picker} list={list} />}
      <SlidePanel open={slideoverId !== null} onClose={() => setSlideoverId(null)} title={slideoverTitle}>
        {slideoverId && <RelationPreview target={target.rawTarget} recordId={slideoverId} isAuthUser={target.isAuthUser} onClose={() => setSlideoverId(null)} />}
      </SlidePanel>
    </div>
  )
}
