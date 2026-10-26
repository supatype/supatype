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
  state: PublishingState | null
  /** The form holds edits nobody has saved. Publishing saves them first. */
  dirty: boolean
  /** The record does not exist yet: the first save or publish creates it. */
  creating: boolean
  /**
   * The language the editor is showing, which must be one of `locales`. Null when the record
   * publishes as a whole, or the editor shows a language the record does not publish under.
   */
  editing: Language | null
  /** Each language's name by its code, for the note's list of those still to publish. */
  labels: Readonly<Record<string, string>>
}

export interface PanelMenu {
  /** A time is set, so the menu changes or cancels it rather than setting one. */
  scheduled: boolean
  /** Some language has something to publish: "Publish all languages" and Schedule. */
  canPublishAll: boolean
  canDiscard: boolean
  /** Unpublish the whole record, every language at once. */
  canUnpublishAll: boolean
  /** "Unpublish in {language}": the language on screen is live. */
  canUnpublishOne: boolean
}

export interface PanelModel {
  status: RecordStatus
  /** "Live since" or "Goes live", with the time. */
  since: { label: string; at: string } | null
  /**
   * The language on screen, which the main button publishes and "Unpublish in" withdraws. Null
   * when the main button publishes every language and the menu has no per-language items.
   */
  language: Language | null
  /** What is on screen differs from what is live: a saved edit waiting, or unsaved edits to it. */
  changed: boolean
  /** The main button. */
  primary: { label: string; disabled: boolean }
  /** The line under the controls, about what is on screen. It also explains a greyed main button. */
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

/** Some locales of the record, summarised once for everything the panel says about them. */
interface Scope {
  states: LocaleState[]
  status: RecordStatus
  /** The world reads any of them now, whatever is waiting on top of it. */
  readable: boolean
  /** They differ from what is live: a saved edit waiting, or unsaved edits to a live one. */
  changed: boolean
  /** They hold anything to publish: an edit waiting, an unsaved one, or a locale not live. */
  publishable: boolean
}

function scopeOf(input: PanelInput, locales: string[]): Scope {
  const states = locales.map((l) => input.state?.locales[l] ?? "absent")
  const liveAt = input.state?.liveAt ?? {}
  const readable = locales.some((l) => l in liveAt)
  const waiting = input.state !== null && states.some((s) => s !== "live")
  return {
    states,
    status: STATUS[publishingSummary(input.state, locales)],
    readable,
    changed: states.includes("pending") || (input.dirty && readable),
    publishable: input.creating || input.dirty || waiting,
  }
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
 * What the main button will do, in words. In a language it is named, as Payload's "Publish in
 * {locale}" does, so nobody publishes a language they were not looking at.
 */
function primaryLabel(scope: Scope, language: Language | null): string {
  const act = scope.status === "scheduled" ? "Publish now" : scope.changed ? "Publish changes" : "Publish"
  return language === null ? act : `${act} in ${language.label}`
}

/**
 * The line under the controls, about the language on screen and named for it. When that language
 * has nothing to publish it also names the others that do, since the greyed main button and "no
 * changes" read as if nothing were left anywhere while another language was still a draft.
 */
function noteOf(input: PanelInput, scope: Scope): string | null {
  const name = input.editing?.label
  if (scope.status === "draft") return name === undefined ? "Not on the live site yet." : `Not on the live site in ${name} yet.`
  if (scope.status === "scheduled") return "Change or cancel the schedule from the menu."
  if (scope.status === "partial") return null
  if (scope.changed) return `The live site still shows the published version${name === undefined ? "" : ` in ${name}`}.`
  if (name === undefined) return "Live, no changes to publish."
  const waiting = stillToPublish(input)
  return `Live in ${name}, no changes to publish.${waiting.length === 0 ? "" : ` Still to publish: ${waiting.join(", ")}.`}`
}

/** The names of the languages other than the one on screen that are not live as saved. */
function stillToPublish(input: PanelInput): string[] {
  const others = input.locales.filter((l) => l !== input.editing?.code && (input.state?.locales[l] ?? "absent") !== "live")
  return others.map((l) => input.labels[l] ?? l)
}

/** The menu: per-language acts on `onScreen`, the rest on the whole record. */
function menuOf(input: PanelInput, whole: Scope, onScreen: Scope | null): PanelMenu {
  // A saved edit can be discarded only back to one published version; unsaved edits always can.
  const discardable = input.dirty || (input.state?.discardTo ?? null) !== null
  return {
    scheduled: whole.status === "scheduled",
    canPublishAll: whole.publishable,
    canDiscard: !input.creating && whole.changed && discardable,
    canUnpublishAll: !input.creating && whole.readable,
    canUnpublishOne: !input.creating && onScreen !== null && onScreen.readable,
  }
}

/**
 * The whole panel, from the record's state. The badge and the whole-record menu items read every
 * language; the main button, the Changed flag and the note read the language on screen.
 */
export function describePanel(input: PanelInput): PanelModel {
  const language = input.editing
  const whole = scopeOf(input, input.locales)
  const onScreen = language === null ? null : scopeOf(input, [language.code])
  const shown = onScreen ?? whole
  const localeRows = new Set(whole.states).size > 1
  return {
    status: whole.status,
    since: sinceOf(whole.status, input.state),
    language,
    changed: shown.changed,
    primary: { label: primaryLabel(shown, language), disabled: !shown.publishable },
    note: noteOf(input, shown),
    viewChanges: shown.status === "published" && shown.states.includes("pending"),
    localeRows,
    rowPublish: localeRows ? input.locales.filter((l, i) => whole.states[i] !== "live" && l !== language?.code) : [],
    menu: menuOf(input, whole, onScreen),
  }
}
