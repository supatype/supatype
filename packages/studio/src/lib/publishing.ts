import { DRAFT_SCHEMA, type SupatypeClient } from "@supatype/client"
import type { ModelConfig, ModelVersionsConfig } from "../config.js"

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
    .from(versions.versionsTable as never)
    .select("id, version, status, created_at, created_by, data, published_locales, scheduled_locales")
    .eq("record_id", recordId)
    .order("version", { ascending: false })

  if (result.error !== null || result.data === null) return []
  return result.data as unknown as RecordVersion[]
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
  const states: Record<string, LocaleState> = {}

  for (const locale of locales) {
    const liveVersion = versions.find((v) => locale in v.published_locales)
    if (liveVersion === undefined) {
      states[locale] = newest !== null && locale in newest.scheduled_locales ? "scheduled" : "absent"
      continue
    }
    if (newest !== null && newest.version > liveVersion.version) {
      states[locale] = locale in newest.scheduled_locales ? "scheduled" : "pending"
      continue
    }
    states[locale] = "live"
  }

  return {
    versions,
    newest,
    hasPendingDraft: newest !== null && Object.keys(newest.published_locales).length === 0,
    locales: states,
  }
}

/** Read the pending draft's values, which is what an editor opens. */
export async function fetchDraft(
  client: SupatypeClient,
  model: ModelConfig,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const result = await client
    .from(model.tableName as never)
    .draft()
    .select()
    .eq(model.primaryKey, recordId)
    .maybeSingle()

  if (result.error !== null) return null
  return (result.data as Record<string, unknown> | null) ?? null
}

/**
 * The one state that stands for a whole record.
 *
 * Used by the publishing section's header, which is what somebody sees while the section is shut.
 * It returns a state rather than a label on purpose: the words live in one table beside the badge
 * that renders them, so the header and the rows underneath it cannot end up calling the same thing
 * by two different names. They briefly did, in the same 280px column.
 *
 * Order matters. An edit waiting outranks a schedule, because a schedule is a decision already
 * taken and an unpublished edit is one nobody has made yet. `live` requires unanimity: one
 * unpublished translation under a green badge is the exact lie the per-locale design exists to
 * prevent, and an empty locale list must not reach it through a vacuous `every`.
 */
export function publishingSummary(
  state: PublishingState | null,
  locales: string[],
): LocaleState {
  const states = locales.map((locale) => state?.locales[locale] ?? "absent")
  if (states.length > 0 && states.every((s) => s === "live")) return "live"
  if (states.some((s) => s === "pending")) return "pending"
  if (states.some((s) => s === "scheduled")) return "scheduled"
  return "absent"
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
  const result = await client.rpc(fn as never, params as never, { schema: RPC_SCHEMA })
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
    .from(model.tableName as never)
    .select()
    .eq(model.primaryKey, recordId)
    .single()

  if (result.error !== null) {
    return { values: null, fromDraft: false, error: result.error.message }
  }
  // A proxy may drop `Accept: object+json` and answer with a one-row array.
  const raw = result.data as unknown
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined
  if (row === undefined || typeof row !== "object") {
    return { values: null, fromDraft: false, error: "Record not found" }
  }
  return { values: row, fromDraft: false, error: null }
}

/**
 * Which of these records have an edit waiting.
 *
 * One query for the page rather than one per row: a list of fifty records should cost one request,
 * and the alternative is fifty round trips to render a badge.
 *
 * Only the three columns the answer needs, and deliberately **not** `data`: a page of records with
 * twenty versions each would otherwise pull every snapshot of every one of them across the wire to
 * decide whether to draw a dot.
 *
 * Returns an empty set on any failure. A missing badge is a smaller wrong than a list that will not
 * render, and the record's own editor is authoritative about its state anyway.
 */
export async function fetchPendingDraftIds(
  client: SupatypeClient,
  model: ModelConfig,
  recordIds: string[],
): Promise<Set<string>> {
  const versions = model.versions
  if (versions === null || !versions.drafts || recordIds.length === 0) return new Set()

  const result = await client
    .from(versions.versionsTable as never)
    .select("record_id, version, published_locales")
    .in("record_id", recordIds)
    .order("version", { ascending: false })

  if (result.error !== null || result.data === null) return new Set()

  const newest = new Map<string, number>()
  const live = new Map<string, number>()
  for (const raw of result.data as unknown as Array<{
    record_id: string
    version: number
    published_locales: Record<string, string> | null
  }>) {
    const id = String(raw.record_id)
    newest.set(id, Math.max(newest.get(id) ?? 0, raw.version))
    if (raw.published_locales !== null && Object.keys(raw.published_locales).length > 0) {
      live.set(id, Math.max(live.get(id) ?? 0, raw.version))
    }
  }

  const pending = new Set<string>()
  for (const [id, version] of newest) {
    // Never published counts as waiting: there is content nobody outside can see.
    if (version > (live.get(id) ?? 0)) pending.add(id)
  }
  return pending
}
