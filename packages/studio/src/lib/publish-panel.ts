import { publishingSummary, type LocaleState, type PublishingState } from "./publishing.js"

/**
 * What the publish panel says and offers, as a function of the record's state.
 *
 * Kept apart from the component so every state the panel can be in is a plain value a test can
 * name: which badge, which line under it, what the main button says, and which menu items work.
 */

/** The one status a record has, as the badge at the top of the panel names it. */
export type RecordStatus = "draft" | "published" | "scheduled" | "partial"

export interface PanelInput {
  locales: string[]
  /** A model with no localized field publishes as a whole and never shows language rows. */
  wholeRecord: boolean
  state: PublishingState | null
  /** The form holds edits nobody has saved. Publishing saves them first. */
  dirty: boolean
  /** The record does not exist yet: the first save or publish creates it. */
  creating: boolean
}

export interface PanelMenu {
  /** A time is set, so the menu changes or cancels it rather than setting one. */
  scheduled: boolean
  canSchedule: boolean
  canDiscard: boolean
  canUnpublish: boolean
}

export interface PanelModel {
  status: RecordStatus
  /** Something differs from what is live: a saved edit waiting, or unsaved edits to a live record. */
  changed: boolean
  /** "Live since" or "Goes live", with the time. */
  since: { label: string; at: string } | null
  primary: { label: string; disabled: boolean }
  note: string | null
  /** Offer a way to the history, where the waiting edit can be compared with what is live. */
  viewChanges: boolean
  /** Languages are in different states, so each gets a row. */
  localeRows: boolean
  /**
   * Each row not live offers its own Publish. Not when only one language is waiting: the main
   * button already says "Publish fr", and a second control for the same act reads as a different one.
   */
  rowPublish: boolean
  menu: PanelMenu
}

const STATUS: Record<ReturnType<typeof publishingSummary>, RecordStatus> = {
  live: "published",
  pending: "published",
  partial: "partial",
  scheduled: "scheduled",
  absent: "draft",
}

/** Each locale's state, or never published while nothing has loaded. */
function statesOf(input: PanelInput): LocaleState[] {
  return input.locales.map((l) => input.state?.locales[l] ?? "absent")
}

/** Whether the panel has anything it could publish: an edit waiting, an unsaved one, or a locale not live. */
function hasSomethingToPublish(input: PanelInput, states: LocaleState[]): boolean {
  if (input.creating || input.dirty) return true
  return input.state !== null && states.some((s) => s !== "live")
}

function sinceOf(status: RecordStatus, state: PublishingState | null): PanelModel["since"] {
  if (state === null) return null
  if (status === "published") {
    const times = Object.values(state.liveAt).sort()
    const at = times[times.length - 1]
    return at === undefined ? null : { label: "Live since", at }
  }
  if (status === "scheduled") {
    const at = Object.values(state.scheduledAt).sort()[0]
    return at === undefined ? null : { label: "Goes live", at }
  }
  return null
}

/**
 * The languages Publish would put live: those not live now, or every one when unsaved edits are
 * saved first, since those make a new version every language is behind.
 */
function languagesToPublish(input: PanelInput, states: LocaleState[]): string[] {
  if (input.dirty) return input.locales
  return input.locales.filter((_, i) => states[i] !== "live")
}

/**
 * What the main button will do, in words. With languages in different states it names them
 * ("Publish fr", "Publish 2 languages"), as Payload's "Publish in {locale}" does: "Publish all"
 * read as every language on a record where only one was waiting.
 */
function primaryLabel(status: RecordStatus, changed: boolean, languages: string[] | null): string {
  if (status === "scheduled") return "Publish now"
  if (languages !== null && languages.length > 0) {
    return languages.length === 1 ? `Publish ${languages[0] ?? ""}` : `Publish ${String(languages.length)} languages`
  }
  return changed ? "Publish changes" : "Publish"
}

function noteOf(status: RecordStatus, changed: boolean): string | null {
  if (status === "draft") return "Not on the live site yet."
  if (status === "scheduled") return "Change or cancel the schedule from the menu."
  if (status === "partial") return null
  return changed ? "The live site still shows the published version." : "Live, no changes to publish."
}

/** Whether the world reads any of the record now, whatever is waiting on top of it. */
function isReadable(input: PanelInput): boolean {
  const liveAt = input.state?.liveAt ?? {}
  return input.locales.some((l) => l in liveAt)
}

function menuOf(input: PanelInput, status: RecordStatus, changed: boolean, publishable: boolean): PanelMenu {
  const readable = isReadable(input)
  // A saved edit can be discarded only back to one published version; unsaved edits always can.
  const discardable = input.dirty || (input.state?.discardTo ?? null) !== null
  return {
    scheduled: status === "scheduled",
    canSchedule: publishable,
    canDiscard: !input.creating && changed && discardable,
    canUnpublish: !input.creating && readable,
  }
}

/** The whole panel, from the record's state. */
export function describePanel(input: PanelInput): PanelModel {
  const states = statesOf(input)
  const status = STATUS[publishingSummary(input.state, input.locales)]
  const changed = states.includes("pending") || (input.dirty && isReadable(input))
  const localeRows = !input.wholeRecord && new Set(states).size > 1
  const publishable = hasSomethingToPublish(input, states)
  const languages = localeRows ? languagesToPublish(input, states) : null
  return {
    status,
    changed,
    since: sinceOf(status, input.state),
    primary: { label: primaryLabel(status, changed, languages), disabled: !publishable },
    note: noteOf(status, changed),
    viewChanges: status === "published" && states.includes("pending"),
    localeRows,
    rowPublish: localeRows && (languages?.length ?? 0) > 1,
    menu: menuOf(input, status, changed, publishable),
  }
}
