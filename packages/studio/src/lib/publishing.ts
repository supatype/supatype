import { DRAFT_SCHEMA, type SupatypeClient } from "@supatype/client"
import type { ModelConfig, ModelVersionsConfig } from "../config.js"
import {
  isJsonObject,
  isNumber,
  isOneOf,
  isRecordOf,
  isShape,
  isString,
  isUnknown,
  nullable,
  sameJson,
  type Guard,
} from "./json.js"

/**
 * The publishing operations, as calls rather than as SQL.
 *
 * Every one of these is a generated `supatype.*` function, and they are generated rather than
 * written here for a reason worth keeping in view: they run as the caller, so the access rule that
 * already governs editing a record governs drafting, publishing and restoring it. Studio calling the
 * same functions an app would means there is one set of rules, not one for the UI and one for
 * everyone else.
 *
 * They live in the `supatype` schema, so every call names it. PostgREST resolves `/rpc/<name>`
 * against the default profile, and a function outside it is a 404 that reads as "no such function".
 */
const RPC_SCHEMA = "supatype"

/** The locale key a model with no localized field publishes under. */
export const WHOLE_RECORD = "*"

/** One row of a record's history, as the snapshot table stores it. */
export interface RecordVersion {
  id: string
  version: number
  status: "draft" | "published"
  /** ISO timestamp. The column is `created_at`; PostgREST does not camel-case it. */
  created_at: string
  /** Who saved it, or null for a write with no subject, such as one through the service role. */
  created_by: string | null
  data: Record<string, unknown>
  /** Locales this version is live for, mapped to when each went live. */
  published_locales: Record<string, string>
  /** Locales this version is due to go live for, mapped to when. */
  scheduled_locales: Record<string, string>
}

const isLocaleTimes = isRecordOf(isString)

/** A row of the snapshot table, as the engine's versions DDL declares it. */
const isRecordVersion: Guard<RecordVersion> = isShape({
  id: isString,
  version: isNumber,
  status: isOneOf(["draft", "published"] as const),
  created_at: isString,
  created_by: nullable(isString),
  data: isJsonObject,
  published_locales: isLocaleTimes,
  scheduled_locales: isLocaleTimes,
})

/**
 * The columns a list's state query selects. Only the ones the derivation reads: selecting `data` for
 * every version of every row on screen would pull the whole table through the list.
 */
const isStateRow = isShape({
  record_id: isUnknown,
  version: isNumber,
  published_locales: nullable(isLocaleTimes),
  scheduled_locales: nullable(isLocaleTimes),
})

/**
 * The part of a version the per-locale derivation reads: where it is published, and its content
 * when the caller selected it. Without content a newer version always counts as a change.
 */
type VersionPublication = Pick<RecordVersion, "version" | "published_locales" | "scheduled_locales"> & {
  data?: Record<string, unknown> | undefined
}

/** What a record's history says about one locale. */
export type LocaleState = "live" | "pending" | "scheduled" | "absent"

export interface PublishingState {
  versions: RecordVersion[]
  /** The newest version, which is what a draft read and a publish both work from. */
  newest: RecordVersion | null
  /** True when the newest version is a draft nobody has published. */
  hasPendingDraft: boolean
  /** Per locale: what the world currently sees, and whether an edit is waiting. */
  locales: Record<string, LocaleState>
  /** Per live locale: when what the world reads in it went live. */
  liveAt: Record<string, string>
  /** Per scheduled locale: when it is due to go live. */
  scheduledAt: Record<string, string>
  /**
   * The version "Discard changes" returns the record to: the one version every live locale reads,
   * when an edit is waiting on top of it. Null when nothing is waiting, or when languages are live
   * from different versions and there is no single published state to return to.
   */
  discardTo: number | null
}

/**
 * The locales a model publishes under.
 *
 * A model with no localized column publishes as a whole, under the single key `*`, so callers have
 * one shape to handle rather than two.
 */
export function publishableLocales(
  versions: ModelVersionsConfig,
  projectLocales: string[],
): string[] {
  if (versions.localizedColumns.length === 0 || projectLocales.length === 0) {
    return [WHOLE_RECORD]
  }
  return projectLocales
}

/**
 * Read a record's history, newest first.
 *
 * Returns an empty history rather than throwing when the table is absent: a model that has just
 * gained `versions` has no snapshots until someone saves, and an editor opening it should see an
 * empty history rather than an error.
 */
export async function fetchVersions(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
): Promise<RecordVersion[]> {
  const versions = model.versions
  if (versions === null) return []

  const result = await client
    .from(versions.versionsTable)
    .select("id, version, status, created_at, created_by, data, published_locales, scheduled_locales")
    .eq("record_id", recordId)
    .order("version", { ascending: false })

  if (result.error !== null || result.data === null) return []
  return result.data.filter(isRecordVersion)
}

/**
 * What the history says about the record, per locale.
 *
 * `live` means the world sees this locale. `pending` means a newer version exists that has not been
 * published for it, which is the state the whole feature exists to make possible. `scheduled` means
 * a pending edit has a time on it. `absent` means the locale has never gone live.
 *
 * Derived rather than stored, because a stored answer is a second source of truth about publication
 * and the version rows already say it exactly.
 */
export function publishingState(
  versions: RecordVersion[],
  locales: string[],
): PublishingState {
  const newest = versions[0] ?? null
  const states = localeStates(versions, locales)
  return {
    versions,
    newest,
    hasPendingDraft: newest !== null && Object.keys(newest.published_locales).length === 0,
    locales: states,
    liveAt: liveTimes(versions, locales),
    scheduledAt: pick(newest?.scheduled_locales ?? {}, locales.filter((l) => states[l] === "scheduled")),
    discardTo: discardTarget(versions, locales, states),
  }
}

/** The entries of `times` for `keys`, leaving out the keys it has no entry for. */
function pick(times: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((k) => (times[k] === undefined ? [] : [[k, times[k]]])))
}

/** When each locale's live version went live for it. */
function liveTimes(versions: readonly RecordVersion[], locales: string[]): Record<string, string> {
  const times: Record<string, string> = {}
  for (const locale of locales) {
    const at = versions.find((v) => locale in v.published_locales)?.published_locales[locale]
    if (at !== undefined) times[locale] = at
  }
  return times
}

/** The single version every live locale reads, when an edit is waiting on top of it. */
function discardTarget(
  versions: readonly RecordVersion[],
  locales: string[],
  states: Record<string, LocaleState>,
): number | null {
  if (!locales.some((l) => states[l] === "pending" || states[l] === "scheduled")) return null
  const live = new Set(
    locales.flatMap((l) => versions.find((v) => l in v.published_locales)?.version ?? []),
  )
  const [only] = live
  return live.size === 1 && only !== undefined ? only : null
}

/**
 * True when `newer` says exactly what `live` says, so publishing it would change nothing.
 *
 * A save with no edits and "Discard changes" (which restores the live version as a new draft) both
 * leave such a version on top. Counting it as an edit waiting offered to publish nothing and kept a
 * discarded record marked as changed. Unknown content counts as different.
 */
function sameContent(newer: VersionPublication, live: VersionPublication): boolean {
  return newer.data !== undefined && live.data !== undefined && sameJson(newer.data, live.data)
}

/** Each locale's state, from a history ordered newest first. */
function localeStates(versions: readonly VersionPublication[], locales: string[]): Record<string, LocaleState> {
  const newest = versions[0] ?? null
  const states: Record<string, LocaleState> = {}

  for (const locale of locales) {
    const liveVersion = versions.find((v) => locale in v.published_locales)
    if (liveVersion === undefined) {
      states[locale] = newest !== null && locale in newest.scheduled_locales ? "scheduled" : "absent"
      continue
    }
    if (newest !== null && newest.version > liveVersion.version && !sameContent(newest, liveVersion)) {
      states[locale] = locale in newest.scheduled_locales ? "scheduled" : "pending"
      continue
    }
    states[locale] = "live"
  }
  return states
}

/** True when `value` says something in a locale: not absent, null, empty text or an empty value. */
function hasContent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false
  if (Array.isArray(value)) return value.length > 0
  if (isJsonObject(value)) return Object.keys(value).length > 0
  return true
}

/**
 * When the live row went or goes live: its `published_at`, or now when the model has no such
 * column, since nothing in the row withholds it. `null` for a row nothing has published.
 */
function liveSince(row: Record<string, unknown>, now: number): number | null {
  if (!(PUBLISHED_AT in row)) return now
  const at = row[PUBLISHED_AT]
  if (!isString(at)) return null
  const time = Date.parse(at)
  return Number.isNaN(time) ? null : time
}

/**
 * Each locale's state read from the live row, for a record with no version rows.
 *
 * Rows a seed wrote, rows inserted through the API and rows saved before 0.7.0 have no history,
 * and reading them from history alone called a record the public is reading "Not published". The
 * row says what the read rule shows instead: `published_at` at or before now is live, later is
 * scheduled, and null is a draft. On a localized model only the locales the row holds content in
 * are live, because publishing a locale is what writes its keys and unpublishing removes them. The
 * engine writes version 1 for such a record by the same rule, so the two agree once it has.
 */
export function liveRowLocaleStates(
  row: Record<string, unknown>,
  versions: ModelVersionsConfig,
  locales: string[],
  now: number = Date.now(),
): Record<string, LocaleState> {
  const at = liveSince(row, now)
  const state: LocaleState = at === null ? "absent" : at <= now ? "live" : "scheduled"
  const states: Record<string, LocaleState> = {}
  for (const locale of locales) {
    const held =
      locale === WHOLE_RECORD ||
      versions.localizedColumns.some((column) => {
        const value = row[column]
        return isJsonObject(value) && hasContent(value[locale])
      })
    states[locale] = held ? state : "absent"
  }
  return states
}

/**
 * A record's publishing state: from its history, or from its live row when it has none.
 *
 * The live row is read only for a record with no version rows, which the editor then shows as the
 * row stands rather than as never published.
 */
export async function fetchPublishingState(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  locales: string[],
): Promise<PublishingState> {
  const versions = await fetchVersions(client, model, recordId)
  if (versions.length > 0 || model.versions === null) return publishingState(versions, locales)
  const row = await fetchLiveRow(client, model, recordId)
  if (row === null) return publishingState([], locales)
  return liveRowState(row, model.versions, locales)
}

/** A record with no history, as its live row stands: its `published_at` is when, if anything. */
export function liveRowState(
  row: Record<string, unknown>,
  versions: ModelVersionsConfig,
  locales: string[],
  now: number = Date.now(),
): PublishingState {
  const states = liveRowLocaleStates(row, versions, locales, now)
  const at = row[PUBLISHED_AT]
  const timesFor = (state: LocaleState): Record<string, string> =>
    isString(at) ? Object.fromEntries(locales.filter((l) => states[l] === state).map((l) => [l, at])) : {}
  return {
    versions: [],
    newest: null,
    hasPendingDraft: false,
    locales: states,
    liveAt: timesFor("live"),
    scheduledAt: timesFor("scheduled"),
    discardTo: null,
  }
}

/** The record's live row, or null when it cannot be read. */
async function fetchLiveRow(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const result = await client
    .from(model.tableName)
    .select()
    .eq(model.primaryKey, recordId)
    .maybeSingle()
  if (result.error !== null) return null
  // A proxy may drop `Accept: object+json` and answer with a one-row array.
  const raw: unknown = Array.isArray(result.data) ? result.data[0] : result.data
  return isJsonObject(raw) ? raw : null
}

/** Read the pending draft's values, which is what an editor opens. */
export async function fetchDraft(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const result = await client
    .from(model.tableName)
    .draft()
    .select()
    .eq(model.primaryKey, recordId)
    .maybeSingle()

  if (result.error !== null) return null
  return isJsonObject(result.data) ? result.data : null
}

/**
 * What a whole record is, as opposed to what one locale is.
 *
 * `partial` is the state a per-locale design needs and a per-locale vocabulary cannot say: some
 * languages are live and others have never been published. Without it the summary had to pick the
 * worst single locale, so a post live in English with no French translation reported as "Not
 * published", and the list called the same record "Draft" while its English was being read by the
 * public.
 */
export type RecordState = LocaleState | "partial"

/**
 * The state that stands for a whole record.
 *
 * Returns a state rather than a label: the words live in one table beside the badge that renders
 * them, so the list, the collapsed header and the row underneath it cannot end up calling the same
 * thing by different names. They did, and two of the names were "Draft".
 *
 * Order matters, and `partial` outranks the rest for a reason. "Some of this is public and some of
 * it has never been" is the fact an editor most needs and the one every other label hides.
 * Otherwise an edit waiting outranks a schedule, because a schedule is a decision already taken and
 * an unpublished edit is one nobody has made yet. `live` requires unanimity: one unpublished
 * translation under a green badge is exactly the lie this exists to prevent, and an empty locale
 * list must not reach it through a vacuous `every`.
 */
export function publishingSummary(
  state: Pick<PublishingState, "locales"> | null,
  locales: string[],
): RecordState {
  const states = locales.map((locale) => state?.locales[locale] ?? "absent")
  if (states.length === 0) return "absent"
  if (states.every((s) => s === "live")) return "live"

  const anyPublished = states.some((s) => s !== "absent")
  const anyNeverPublished = states.some((s) => s === "absent")
  if (anyPublished && anyNeverPublished) return "partial"

  if (states.some((s) => s === "pending")) return "pending"
  if (states.some((s) => s === "scheduled")) return "scheduled"
  return "absent"
}

/**
 * Which locales the world can currently read, for the detail beside a summary badge.
 *
 * With two or three languages the specifics fit and are what an editor actually wants: "en live, fr
 * not" answers the question the badge only raises.
 */
export function liveLocales(state: PublishingState | null, locales: string[]): string[] {
  return locales.filter((locale) => {
    const s = state?.locales[locale]
    // Scheduled is not live yet, and pending means an older version of it is: both are readable.
    return s === "live" || s === "pending"
  })
}

/** The schema a read of this model should come from, given whether the editor wants the draft. */
export function profileFor(model: ModelConfig, wantDraft: boolean): string | undefined {
  return wantDraft && model.versions?.drafts === true ? DRAFT_SCHEMA : undefined
}

async function call(
  client: SupatypeClient,
  fn: string,
  params: Record<string, unknown>,
): Promise<{ error: string | null }> {
  const result = await client.rpc(fn, params, { schema: RPC_SCHEMA })
  return { error: result.error?.message ?? null }
}

/** Save the editor's values as a new draft. The live row does not move. */
export function createDraft(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  data: Record<string, unknown>,
): Promise<{ error: string | null }> {
  return call(client, "create_draft", {
    model_table: model.tableName,
    record_id: recordId,
    data,
  })
}

/**
 * Record the live row as it stands as the record's first version.
 *
 * For a record with no history (a seed, an API insert, a save before 0.7.0). `publish` and
 * `schedule_publish` need a version to work from, and `unpublish` on a localized model removes the
 * locale's keys from the live row, which for such a record is the only copy of its content. An
 * empty draft merges onto the live row, so this writes exactly what is there.
 */
export function snapshotLiveRow(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
): Promise<{ error: string | null }> {
  return createDraft(client, model, recordId, {})
}

/** Why a write was refused, with the field it names when the server named one. */
export interface RecordError {
  message: string
  field?: string | undefined
  /** The SQLSTATE, when the server sent one. */
  code?: string | undefined
  /** Postgres's detail line, which names the columns of a unique violation. */
  details?: string | undefined
}

/** A record just created: its id, or why it was not. */
export interface CreatedRecord {
  id: string | null
  error: RecordError | null
}

/**
 * Create a record from the editor's values.
 *
 * A model with drafts creates it through `supatype.create_record`, which makes the live row holding
 * no locale and saves the values as version 1, so nothing typed into the form reaches readers until
 * it is published. Inserting the live row with the whole form, as Studio did, put every translation
 * typed at creation live as soon as any one locale was published.
 */
export async function createRecord(
  client: SupatypeClient,
  model: ModelConfig,
  values: Record<string, unknown>,
): Promise<CreatedRecord> {
  if (model.versions?.drafts === true) {
    const params = { model_table: model.tableName, data: values }
    const result = await client.rpc("create_record", params, { schema: RPC_SCHEMA })
    if (result.error !== null) return { id: null, error: result.error }
    return idOf(isJsonObject(result.data) ? result.data["record_id"] : undefined)
  }
  const result = await client.from(model.tableName).insert(values)
  if (result.error !== null) return { id: null, error: result.error }
  const row: unknown = Array.isArray(result.data) ? result.data[0] : undefined
  return idOf(isJsonObject(row) ? row[model.primaryKey] : undefined)
}

/** The columns a copy never takes from its original, whatever the model. */
const NEVER_COPIED = ["created_at", "updated_at"]

/**
 * The column the engine treats as a drafts model's publish date: `publish` sets it and withdrawing
 * the last locale clears it, so a read rule comparing it sees an unpublished record as hidden.
 */
const PUBLISHED_AT = "published_at"

/**
 * The values a duplicate of a record is created from: the original's, less what belongs to the
 * original alone.
 *
 * On a model with drafts that includes `published_at`. A copy is a new, unpublished record, and a
 * copied publish date made the live row readable under a rule like `published_at <= now()` before
 * anyone published it. The rest of a record's publishing state (which version is live or scheduled,
 * per locale) lives on its version rows, which a copy does not take: it starts at version 1.
 */
export function duplicateValues(
  model: ModelConfig,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const dropped = new Set([model.primaryKey, ...NEVER_COPIED])
  if (model.versions?.drafts === true) dropped.add(PUBLISHED_AT)
  return Object.fromEntries(Object.entries(values).filter(([column]) => !dropped.has(column)))
}

function idOf(value: unknown): CreatedRecord {
  return value === undefined || value === null
    ? { id: null, error: { message: "No data returned" } }
    : { id: String(value), error: null }
}

/**
 * Promote a version into the live row.
 *
 * `version` omitted means the newest, and `locales` omitted means every locale the project declares.
 * Naming a version is how "publish this one" on a history row works: the function moves the claim,
 * so exactly one version is ever live for a locale.
 */
export function publish(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  options?: { version?: number; locales?: string[] },
): Promise<{ error: string | null }> {
  return call(client, "publish", {
    model_table: model.tableName,
    record_id: recordId,
    ...(options?.version !== undefined && { version: options.version }),
    ...(options?.locales !== undefined && { locales: options.locales }),
  })
}

/** Withdraw some or all locales. The content stays in the row. */
export function unpublish(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  locales?: string[],
): Promise<{ error: string | null }> {
  return call(client, "unpublish", {
    model_table: model.tableName,
    record_id: recordId,
    ...(locales !== undefined && { locales }),
  })
}

/**
 * Bring an earlier version back as a new draft.
 *
 * Never as an immediate publish: restoring is an editing act, so it lands where an edit lands and
 * goes live only when someone publishes it. That is also what makes "publish this old version" two
 * calls rather than one, and Studio spends both behind a single button.
 */
export function restoreVersion(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  version: number,
): Promise<{ error: string | null }> {
  return call(client, "restore_version", {
    model_table: model.tableName,
    record_id: recordId,
    version,
  })
}

/** Put a time on a pending edit. Publishing happens when it arrives, not now. */
export function schedulePublish(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  at: Date,
  options?: { version?: number; locales?: string[] },
): Promise<{ error: string | null }> {
  return call(client, "schedule_publish", {
    model_table: model.tableName,
    record_id: recordId,
    at: at.toISOString(),
    ...(options?.version !== undefined && { version: options.version }),
    ...(options?.locales !== undefined && { locales: options.locales }),
  })
}

/** Take the time off, without publishing anything. */
export function unschedulePublish(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
  options?: { version?: number; locales?: string[] },
): Promise<{ error: string | null }> {
  return call(client, "unschedule_publish", {
    model_table: model.tableName,
    record_id: recordId,
    ...(options?.version !== undefined && { version: options.version }),
    ...(options?.locales !== undefined && { locales: options.locales }),
  })
}

/**
 * The values an editor should open, which is the pending draft when there is one.
 *
 * Falls back to the live row, and that is not just defensive: a record that has just been created
 * has no snapshot until someone saves, so the draft view has no row for it. Reading only the draft
 * would open a blank form over a record that plainly exists.
 *
 * A model that keeps history without withholding writes has no pending version to read either, so it
 * opens the live row like any unversioned model.
 */
export async function fetchRecordForEditing(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
): Promise<{ values: Record<string, unknown> | null; fromDraft: boolean; error: string | null }> {
  if (model.versions?.drafts === true) {
    const draft = await fetchDraft(client, model, recordId)
    if (draft !== null) return { values: draft, fromDraft: true, error: null }
  }

  const result = await client
    .from(model.tableName)
    .select()
    .eq(model.primaryKey, recordId)
    .single()

  if (result.error !== null) {
    return { values: null, fromDraft: false, error: result.error.message }
  }
  // A proxy may drop `Accept: object+json` and answer with a one-row array.
  const raw: unknown = result.data
  const row = Array.isArray(raw) ? raw[0] : raw
  if (!isJsonObject(row)) {
    return { values: null, fromDraft: false, error: "Record not found" }
  }
  return { values: row, fromDraft: false, error: null }
}

/**
 * What each of these records is, for a list that has to say so without opening any of them.
 *
 * It used to answer a boolean: does this record have an unpublished edit. The list rendered that as
 * a badge reading "Draft", which was wrong for the common case, a post whose English is live and
 * whose latest edit is not: the record is published and the word said it was not. Meanwhile the
 * editor two clicks away used "Draft" for a locale that had never been published at all, so the
 * same word meant opposite things on the same screen.
 *
 * The query already selected `published_locales` and threw it away. This keeps it, so the list can
 * tell "never published" from "published, with an edit waiting" from "live in one language and
 * never published in another".
 *
 * Takes the rows on screen rather than their keys: a record with no version rows is read from its
 * live row, as the editor reads it, rather than left without a state.
 */
export async function fetchRecordStates(
  client: SupatypeClient,
  model: ModelConfig,
  records: Record<string, unknown>[],
  locales: string[],
): Promise<Map<string, RecordState>> {
  const versions = model.versions
  if (versions === null || !versions.drafts || records.length === 0) return new Map()

  const ids = records.map((r) => String(r[model.primaryKey]))
  const history = await fetchHistories(client, versions.versionsTable, ids)
  if (history === null) return new Map()
  await attachContent(client, versions.versionsTable, history)

  const states = new Map<string, RecordState>()
  for (const record of records) {
    const id = String(record[model.primaryKey])
    const list = history.get(id)
    // Reuses the per-locale derivation rather than repeating it, so a list badge and the editor's
    // own badge cannot disagree about the same record.
    const perLocale =
      list === undefined
        ? liveRowLocaleStates(record, versions, locales)
        : localeStates(list, locales)
    states.set(id, publishingSummary({ locales: perLocale }, locales))
  }
  return states
}

const isContentRow = isShape({ record_id: isUnknown, version: isNumber, data: isJsonObject })

/** The versions whose content decides whether an edit is waiting: the newest, and each live one. */
function contentVersions(list: readonly VersionPublication[]): VersionPublication[] {
  const [newest, ...older] = list
  if (newest === undefined) return []
  const live = older.filter((v) => Object.keys(v.published_locales).length > 0)
  return live.length === 0 ? [] : [newest, ...live]
}

/**
 * Fill in the content of the versions that decide whether a record has an edit waiting, so the list
 * agrees with the editor about a version that repeats the live one. Only for records with a newer
 * version on top of a live one, and only those versions: the content of every version on screen is
 * the whole table.
 */
async function attachContent(
  client: SupatypeClient,
  versionsTable: string,
  history: Map<string, VersionPublication[]>,
): Promise<void> {
  const wanted = new Map<string, VersionPublication>()
  for (const [id, list] of history) {
    for (const v of contentVersions(list)) wanted.set(`${id}:${String(v.version)}`, v)
  }
  if (wanted.size === 0) return
  const ids = [...new Set([...wanted.keys()].map((key) => key.slice(0, key.lastIndexOf(":"))))]
  const numbers = [...new Set([...wanted.values()].map((v) => v.version))]
  const result = await client
    .from(versionsTable)
    .select("record_id, version, data")
    .in("record_id", ids)
    .in("version", numbers)
  if (result.error !== null || result.data === null) return
  for (const row of result.data.filter(isContentRow)) {
    const target = wanted.get(`${String(row.record_id)}:${String(row.version)}`)
    if (target !== undefined) target.data = row.data
  }
}

/** Each record's version rows, newest first, or null when the history could not be read. */
async function fetchHistories(
  client: SupatypeClient,
  versionsTable: string,
  recordIds: string[],
): Promise<Map<string, VersionPublication[]> | null> {
  const result = await client
    .from(versionsTable)
    .select("record_id, version, published_locales, scheduled_locales")
    .in("record_id", recordIds)
    .order("version", { ascending: false })

  if (result.error !== null || result.data === null) return null

  const rows = new Map<string, VersionPublication[]>()
  for (const raw of result.data.filter(isStateRow)) {
    const id = String(raw.record_id)
    const list = rows.get(id) ?? []
    list.push({
      version: raw.version,
      published_locales: raw.published_locales ?? {},
      scheduled_locales: raw.scheduled_locales ?? {},
    })
    rows.set(id, list)
  }
  return rows
}
