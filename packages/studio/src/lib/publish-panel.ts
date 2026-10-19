import { publishingSummary, type LocaleState, type PublishingState } from "./publishing.js"

/**
 * What the publish panel says and offers, as a function of the record's state.
 *
 * Kept apart from the component so every state the panel can be in is a plain value a test can
 * name: which badge, which line under it, what the main button says, and which menu items work.
 */

/** The one status a record has, as the badge at the top of the panel names it. */
export type RecordStatus = "draft" | "published" | "scheduled" | "partial"

/** A language, by its code and by the name an editor knows it by. */
export interface Language {
  code: string
  label: string
}

export interface PanelInput {
  locales: string[]
  /** A model with no localized field publishes as a whole and never shows language rows. */
  wholeRecord: boolean
  state: PublishingState | null
  /** The form holds edits nobody has saved. Publishing saves them first. */
  dirty: boolean
  /** The record does not exist yet: the first save or publish creates it. */
  creating: boolean
  /** The language the editor is showing. Null when the record publishes as a whole. */
  editing: Language | null
}

/** The menu's acts on a localized record: on the language on screen, and on all of them. */
export interface LanguageMenu {
  /** The language on screen, which the main button and "Unpublish in" act on. */
  language: Language
  /** "Publish all languages": some language has something to publish. */
  canPublishAll: boolean
  /** "Unpublish in {language}": the language on screen is live. */
  canUnpublishOne: boolean
}

export interface PanelMenu {
  /** A time is set, so the menu changes or cancels it rather than setting one. */
  scheduled: boolean
  canSchedule: boolean
  canDiscard: boolean
  /** Unpublish the whole record, every language at once. */
  canUnpublish: boolean
  /** Null when the record publishes as a whole, which has no languages to choose between. */
  languages: LanguageMenu | null
}

export interface PanelModel {
  status: RecordStatus
  /** Something differs from what is live: a saved edit waiting, or unsaved edits to a live record. */
  changed: boolean
  /** "Live since" or "Goes live", with the time. */
  since: { label: string; at: string } | null
  /** The main button. `locales` is what it publishes: null for every locale. */
  primary: { label: string; disabled: boolean; locales: string[] | null }
  note: string | null
  /** Offer a way to the history, where the waiting edit can be compared with what is live. */
  viewChanges: boolean
  /** Languages are in different states, so each gets a row. */
  localeRows: boolean
  /**
   * The rows that offer their own Publish: languages not live, less the one on screen, which the
   * main button already names. A second control for the same act reads as a different one.
   */
  rowPublish: string[]
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

/** Whether `states` hold anything to publish: an edit waiting, an unsaved one, or a locale not live. */
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

/** What the main button will do, in words, for a record that publishes as a whole. */
function primaryLabel(status: RecordStatus, changed: boolean): string {
  if (status === "scheduled") return "Publish now"
  return changed ? "Publish changes" : "Publish"
}

/**
 * What the main button will do in the language on screen, named as Payload's "Publish in {locale}"
 * does, so nobody publishes a language they were not looking at.
 */
function languageLabel(input: PanelInput, language: Language, state: LocaleState): string {
  const name = language.label
  if (state === "scheduled") return `Publish now in ${name}`
  const live = isReadable(input, [language.code])
  if (state === "pending" || (input.dirty && live)) return `Publish changes in ${name}`
  return `Publish in ${name}`
}

function noteOf(status: RecordStatus, changed: boolean): string | null {
  if (status === "draft") return "Not on the live site yet."
  if (status === "scheduled") return "Change or cancel the schedule from the menu."
  if (status === "partial") return null
  return changed ? "The live site still shows the published version." : "Live, no changes to publish."
}

/** Whether the world reads any of `locales` now, whatever is waiting on top of it. */
function isReadable(input: PanelInput, locales: string[] = input.locales): boolean {
  const liveAt = input.state?.liveAt ?? {}
  return locales.some((l) => l in liveAt)
}

function menuOf(input: PanelInput, status: RecordStatus, changed: boolean, publishable: boolean): PanelMenu {
  // A saved edit can be discarded only back to one published version; unsaved edits always can.
  const discardable = input.dirty || (input.state?.discardTo ?? null) !== null
  const { editing } = input
  return {
    scheduled: status === "scheduled",
    canSchedule: publishable,
    canDiscard: !input.creating && changed && discardable,
    canUnpublish: !input.creating && isReadable(input),
    languages:
      editing === null
        ? null
        : {
            language: editing,
            canPublishAll: publishable,
            canUnpublishOne: !input.creating && isReadable(input, [editing.code]),
          },
  }
}

/** The language on screen, when the record publishes per language and the editor shows one of them. */
function editingLanguage(input: PanelInput): Language | null {
  const { editing } = input
  if (input.wholeRecord || editing === null || !input.locales.includes(editing.code)) return null
  return editing
}

/** The main button: for the language on screen, or for the whole record. */
function primaryOf(input: PanelInput, status: RecordStatus, changed: boolean, states: LocaleState[]): PanelModel["primary"] {
  const language = input.editing
  if (language === null) {
    return { label: primaryLabel(status, changed), disabled: !hasSomethingToPublish(input, states), locales: null }
  }
  const state = input.state?.locales[language.code] ?? "absent"
  return {
    label: languageLabel(input, language, state),
    disabled: !hasSomethingToPublish(input, [state]),
    locales: [language.code],
  }
}

/** The whole panel, from the record's state. */
export function describePanel(input: PanelInput): PanelModel {
  const states = statesOf(input)
  const status = STATUS[publishingSummary(input.state, input.locales)]
  const changed = states.includes("pending") || (input.dirty && isReadable(input))
  const localeRows = !input.wholeRecord && new Set(states).size > 1
  const language = editingLanguage(input)
  // Everything below reads the language through this, so a code the record has no locale for acts
  // on the whole record rather than on nothing.
  const scoped = { ...input, editing: language }
  return {
    status,
    changed,
    since: sinceOf(status, input.state),
    primary: primaryOf(scoped, status, changed, states),
    note: noteOf(status, changed),
    viewChanges: status === "published" && states.includes("pending"),
    localeRows,
    rowPublish: localeRows ? input.locales.filter((l, i) => states[i] !== "live" && l !== language?.code) : [],
    menu: menuOf(scoped, status, changed, hasSomethingToPublish(input, states)),
  }
}
