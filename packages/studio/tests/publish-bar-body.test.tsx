import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PublishPanel, type PanelActions } from "../src/components/PublishBar.js"
import { PublishSplitButton, type PublishDialog } from "../src/components/PublishMenu.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { describePanel, type PanelModel } from "../src/lib/publish-panel.js"
import {
  liveRowState,
  publishingState,
  WHOLE_RECORD,
  type PublishingState,
  type RecordVersion,
} from "../src/lib/publishing.js"
import { testClient } from "./support.js"

// The panel in each state a record can be in, rendered from state handed straight in: the
// derivation is the real one, fed version rows (or a live row) the way the server returns them.

const client = testClient({ url: "http://localhost:8000/studio/proxy" })
const LIVE_AT = "2026-10-15T15:49:00Z"
const DUE_AT = "2030-10-21T09:00:00Z"

const noActions: PanelActions = {
  publish: () => {},
  schedule: () => {},
  cancelSchedule: () => {},
  discard: () => {},
  unpublish: () => {},
  saveDraft: () => {},
  viewChanges: () => {},
}

function version(n: number, over: Partial<RecordVersion> = {}): RecordVersion {
  return {
    id: `v${String(n)}`,
    version: n,
    status: "draft",
    created_at: "2026-10-01T09:00:00Z",
    created_by: null,
    data: { title: `edit ${String(n)}` },
    published_locales: {},
    scheduled_locales: {},
    ...over,
  }
}

const published = (n: number, locales: string[] = [WHOLE_RECORD]): RecordVersion =>
  version(n, { status: "published", published_locales: Object.fromEntries(locales.map((l) => [l, LIVE_AT])) })

interface Case {
  state: PublishingState | null
  locales?: string[]
  dirty?: boolean
  creating?: boolean
  /** The language the editor shows, on a localized model. English unless a case says otherwise. */
  editing?: string
}

const NAMES: Record<string, string> = { en: "English", fr: "French", de: "German" }

/** A language as the panel names it. */
function language(code: string): { code: string; label: string } {
  return { code, label: NAMES[code] ?? code }
}

function panelModel({ state, locales = [WHOLE_RECORD], dirty = false, creating = false, editing = "en" }: Case): PanelModel {
  // As PublishBar does: a language goes in only when it is one of the record's own.
  return describePanel({ locales, state, dirty, creating, editing: locales.includes(editing) ? language(editing) : null })
}

function panel(input: Case): string {
  const { state, locales = [WHOLE_RECORD] } = input
  const model = panelModel(input)
  return renderToStaticMarkup(
    <AdminClientContext.Provider value={client}>
      <PublishPanel
        view={{
          panel: model,
          title: "Schemas that refuse bad data",
          locales: locales.map((code) => ({ ...language(code), state: state?.locales[code] ?? "absent" })),
          busy: false,
          saving: false,
          error: null,
        }}
        actions={noActions}
      />
    </AdminClientContext.Provider>,
  )
}

/** The text of the panel's primary button, and whether it is disabled. */
function primary(html: string): { label: string; disabled: boolean } {
  const match = /<button[^>]*class="[^"]*flex-1 min-w-0[^"]*"[^>]*><span[^>]*>([^<]*)<\/span><\/button>/.exec(html)
  if (match === null) throw new Error("no primary button")
  return { label: match[1] ?? "", disabled: match[0].includes('disabled=""') }
}

/** The tooltip on the panel's primary button, which explains why it is greyed out. */
function primaryTitle(html: string): string | null {
  const open = /<button[^>]*class="[^"]*flex-1 min-w-0[^"]*"[^>]*>/.exec(html)?.[0] ?? ""
  return / title="([^"]*)"/.exec(open)?.[1] ?? null
}

/** The labels of the Publish buttons on the language rows. The main button wraps its label in a span. */
function rowPublishes(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>(Publish[^<]*)<\/button>/g)].map((m) => m[1] ?? "")
}

describe("the publish panel's states", () => {
  it("a new record, never published: Draft, Save draft and Publish", () => {
    const html = panel({ state: null, creating: true })
    expect(html).toContain(">Draft<")
    expect(html).toContain("Save draft")
    expect(primary(html)).toEqual({ label: "Publish", disabled: false })
    expect(html).toContain("Not on the live site yet.")
  })

  it("published with no edits since: Published, live since, Publish greyed out with the reason", () => {
    const html = panel({ state: publishingState([published(1)], [WHOLE_RECORD]) })
    expect(html).toContain(">Published<")
    expect(html).not.toContain(">Changed<")
    expect(html).toContain("Live since")
    expect(primary(html)).toEqual({ label: "Publish", disabled: true })
    expect(html).toContain("Live, no changes to publish.")
  })

  it("published then edited: Published and Changed, Publish changes, and a way to see them", () => {
    const html = panel({ state: publishingState([version(2), published(1)], [WHOLE_RECORD]) })
    expect(html).toContain(">Published<")
    expect(html).toContain(">Changed<")
    expect(primary(html)).toEqual({ label: "Publish changes", disabled: false })
    expect(html).toContain("The live site still shows the published version.")
    expect(html).toContain("View changes")
  })

  it("published with unsaved edits in the form: Changed, and Publish changes saves them", () => {
    const html = panel({ state: publishingState([published(1)], [WHOLE_RECORD]), dirty: true })
    expect(html).toContain(">Changed<")
    expect(primary(html)).toEqual({ label: "Publish changes", disabled: false })
  })

  it("scheduled: Scheduled, when it goes live, and Publish now", () => {
    const state = publishingState([version(1, { scheduled_locales: { [WHOLE_RECORD]: DUE_AT } })], [WHOLE_RECORD])
    const html = panel({ state })
    expect(html).toContain(">Scheduled<")
    expect(html).toContain("Goes live")
    expect(primary(html)).toEqual({ label: "Publish now", disabled: false })
    expect(html).toContain("Change or cancel the schedule from the menu.")
  })

  it("languages in different states: Partly published, and a row per language", () => {
    const state = publishingState([published(1, ["en"])], ["en", "fr"])
    const html = panel({ state, locales: ["en", "fr"] })
    expect(html).toContain(">Partly published<")
    expect(html).toContain(">English<")
    expect(html).toContain(">French<")
  })

  it("keeps both halves of the control one colour, whichever half is usable", () => {
    const halves = (state: PublishingState): string[] => {
      const html = panel({ state })
      const group = /<div role="group"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ""
      return [...group.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => (m[1]?.includes("bg-primary") ? "primary" : "secondary"))
    }
    expect(halves(publishingState([version(2), published(1)], [WHOLE_RECORD]))).toEqual(["primary", "primary"])
    // Nothing to publish: the main half is disabled but the menu still works, so the pair steps back
    // together rather than showing a dim half beside a bright one.
    expect(halves(publishingState([published(1)], [WHOLE_RECORD]))).toEqual(["secondary", "secondary"])
  })

  it("joins Publish and its menu into one control", () => {
    const html = panel({ state: publishingState([version(2), published(1)], [WHOLE_RECORD]) })
    const group = /<div role="group"[^>]*>([\s\S]*?)<\/div>/.exec(html)
    expect(group?.[1]).toContain("Publish changes")
    expect(group?.[1]).toContain('aria-label="More publishing actions"')
  })

  it("centres the Publish label on the whole control, so it lines up with Save draft above it", () => {
    // The caret is a fixed 2rem and the action is inset on the left by the same amount (2rem plus
    // its own 0.75rem), so the label's centre is the group's centre rather than its left part's.
    const html = panel({ state: publishingState([version(2), published(1)], [WHOLE_RECORD]) })
    const open = (/<div role="group" class="([^"]*)"/.exec(html)?.[1] ?? "").replaceAll("&amp;", "&").replaceAll("&gt;", ">")
    expect(open).toContain("[&>*:last-child]:w-8")
    expect(open).toContain("[&>*:first-child]:pl-11")
  })

  it("shows no language rows when every language is in the same state", () => {
    const state = publishingState([published(1, ["en", "fr"])], ["en", "fr"])
    const html = panel({ state, locales: ["en", "fr"] })
    // The button names English, so look for the row's own label.
    expect(html).not.toContain(">English<")
    expect(html).not.toContain(">French<")
    expect(primary(html)).toEqual({ label: "Publish in English", disabled: true })
  })

  it("a record with no version rows reads as its live row: published, live since its publish date", () => {
    const row = { id: "r1", title: "Seeded", published_at: LIVE_AT }
    const html = panel({ state: liveRowState(row, { drafts: true, keep: 20, versionsTable: "t", localizedColumns: [] }, [WHOLE_RECORD]) })
    expect(html).toContain(">Published<")
    expect(html).toContain("Live since")
    expect(primary(html)).toEqual({ label: "Publish", disabled: true })
  })

  it("a record with no version rows and no publish date is a draft that can be published", () => {
    const row = { id: "r1", title: "Seeded", published_at: null }
    const html = panel({ state: liveRowState(row, { drafts: true, keep: 20, versionsTable: "t", localizedColumns: [] }, [WHOLE_RECORD]) })
    expect(html).toContain(">Draft<")
    expect(primary(html)).toEqual({ label: "Publish", disabled: false })
  })

  it("waits for the state before offering to publish an existing record", () => {
    // Before the history answers, an existing record's state is unknown: offering Publish then
    // would publish something nobody has seen the state of.
    expect(primary(panel({ state: null })).disabled).toBe(true)
  })
})

describe("publishing one language", () => {
  const EN_FR = ["en", "fr"]

  it("a fresh draft publishes the language on screen, named", () => {
    // Every language a draft: the one choice used to be all of them together.
    const state = publishingState([version(1)], EN_FR)
    expect(primary(panel({ state, locales: EN_FR }))).toEqual({ label: "Publish in English", disabled: false })
    expect(primary(panel({ state, locales: EN_FR, editing: "fr" }))).toEqual({ label: "Publish in French", disabled: false })
  })

  it("a new record names the language too", () => {
    expect(primary(panel({ state: null, locales: EN_FR, creating: true })).label).toBe("Publish in English")
  })

  it("an edit waiting on a live language: Publish changes in that language", () => {
    const state = publishingState([version(2), published(1, EN_FR)], EN_FR)
    expect(primary(panel({ state, locales: EN_FR, editing: "fr" }))).toEqual({ label: "Publish changes in French", disabled: false })
  })

  it("unsaved edits to a live language: Publish changes in that language", () => {
    const state = publishingState([published(1, EN_FR)], EN_FR)
    expect(primary(panel({ state, locales: EN_FR, dirty: true })).label).toBe("Publish changes in English")
  })

  it("unsaved edits to a language never published: plain Publish in that language", () => {
    const state = publishingState([published(1, ["en"])], EN_FR)
    expect(primary(panel({ state, locales: EN_FR, dirty: true, editing: "fr" })).label).toBe("Publish in French")
  })

  it("a scheduled language: Publish now in that language", () => {
    const state = publishingState([version(1, { scheduled_locales: { en: DUE_AT, fr: DUE_AT } })], EN_FR)
    expect(primary(panel({ state, locales: EN_FR }))).toEqual({ label: "Publish now in English", disabled: false })
  })

  it("greys out the button when the language on screen is live, and offers the waiting one on its row", () => {
    const state = publishingState([published(1, ["en"])], EN_FR)
    const html = panel({ state, locales: EN_FR })
    expect(primary(html)).toEqual({ label: "Publish in English", disabled: true })
    expect(rowPublishes(html)).toEqual(["Publish in French"])
  })

  it("does not offer the language on screen a second time on its row", () => {
    const state = publishingState([published(1, ["en"])], ["en", "fr", "de"])
    const html = panel({ state, locales: ["en", "fr", "de"], editing: "fr" })
    expect(primary(html).label).toBe("Publish in French")
    expect(rowPublishes(html)).toEqual(["Publish in German"])
  })

  it("says what the language on screen is doing, not what another language is", () => {
    // English is live as version 2; French is live as version 1, so version 2 waits for it.
    const state = publishingState([published(2, ["en"]), published(1, ["fr"])], EN_FR)
    const english = panel({ state, locales: EN_FR })
    expect(english).toContain(">Published<")
    // French's row says Changed; the flag beside the status badge is about English.
    expect(english).not.toContain("Edited since it was published")
    expect(primary(english)).toEqual({ label: "Publish in English", disabled: true })
    expect(english).toContain("Live, no changes to publish.")
    expect(primaryTitle(english)).toBe("Live, no changes to publish.")
    const french = panel({ state, locales: EN_FR, editing: "fr" })
    expect(french).toContain("Edited since it was published")
    expect(primary(french)).toEqual({ label: "Publish changes in French", disabled: false })
    expect(french).toContain("The live site still shows the published version.")
  })

  it("still offers every language from the menu while the one on screen has nothing waiting", () => {
    const state = publishingState([published(2, ["en"]), published(1, ["fr"])], EN_FR)
    const { menu } = panelModel({ state, locales: EN_FR })
    expect(menu.canPublishAll).toBe(true)
    expect(menu.canUnpublishAll).toBe(true)
    expect(menu.canUnpublishOne).toBe(true)
  })

  it("publishes every language as plain Publish when the language on screen is not one of the record's", () => {
    const model = panelModel({ state: publishingState([version(1)], EN_FR), locales: EN_FR, editing: "de" })
    expect(model.primary.label).toBe("Publish")
    expect(model.language).toBeNull()
  })

  it("publishes only the language on screen from the main button", () => {
    const state = publishingState([version(1)], EN_FR)
    expect(panelModel({ state, locales: EN_FR, editing: "fr" }).language?.code).toBe("fr")
    expect(panelModel({ state: publishingState([version(1)], [WHOLE_RECORD]) }).language).toBeNull()
  })

  it("leaves a model that publishes as a whole saying Publish", () => {
    expect(primary(panel({ state: publishingState([version(1)], [WHOLE_RECORD]) })).label).toBe("Publish")
  })
})

describe("the publish menu's questions", () => {
  function question(dialog: PublishDialog, state: PublishingState, locales: string[] = [WHOLE_RECORD]): string {
    const model = panelModel({ state, locales })
    return renderToStaticMarkup(
      <PublishSplitButton panel={model} title="Schemas that refuse bad data" busy={false} actions={noActions} initialDialog={dialog} />,
    )
  }
  const changed = publishingState([version(2), published(1)], [WHOLE_RECORD])
  const bothLive = publishingState([published(1, ["en", "fr"])], ["en", "fr"])

  it("asks before unpublishing, naming the record and saying the content is kept", () => {
    const html = question("unpublish", changed)
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain("Unpublish &quot;Schemas that refuse bad data&quot;?")
    expect(html).toContain("It comes off the live site. Your content is kept as a draft.")
    expect(html).toContain(">Cancel<")
    expect(html).toContain(">Unpublish<")
  })

  it("asks before unpublishing one language, naming it and saying the others stay", () => {
    const html = question("unpublish-language", bothLive, ["en", "fr"])
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain("Unpublish &quot;Schemas that refuse bad data&quot; in English?")
    expect(html).toContain("English comes off the live site. Other languages stay as they are.")
    expect(html).toContain(">Unpublish in English<")
  })

  it("asks before unpublishing every language of a localized record", () => {
    const html = question("unpublish", bothLive, ["en", "fr"])
    expect(html).toContain("Unpublish &quot;Schemas that refuse bad data&quot; in all languages?")
    expect(html).toContain("It comes off the live site in every language. Your content is kept as a draft.")
    expect(html).toContain(">Unpublish all languages<")
  })

  it("asks before discarding changes", () => {
    const html = question("discard", changed)
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain("Discard changes to &quot;Schemas that refuse bad data&quot;?")
    expect(html).toContain("The draft goes back to the published version.")
  })

  it("asks when to publish", () => {
    expect(question("schedule", changed)).toContain("datetime-local")
  })
})

describe("what the menu offers", () => {
  const menu = (state: PublishingState, locales: string[] = [WHOLE_RECORD], editing = "en") =>
    panelModel({ state, locales, editing }).menu

  it("offers discard only when there is a published version to go back to", () => {
    expect(menu(publishingState([version(2), published(1)], [WHOLE_RECORD])).canDiscard).toBe(true)
    expect(menu(publishingState([published(1)], [WHOLE_RECORD])).canDiscard).toBe(false)
    expect(menu(publishingState([version(1)], [WHOLE_RECORD])).canDiscard).toBe(false)
  })

  it("does not offer discard when languages are live from different versions", () => {
    // There is no one published state to return to, so which one would it be?
    const state = publishingState([version(3), published(2, ["en"]), published(1, ["fr"])], ["en", "fr"])
    expect(menu(state, ["en", "fr"]).canDiscard).toBe(false)
  })

  it("offers unpublish only while the world reads something", () => {
    expect(menu(publishingState([published(1)], [WHOLE_RECORD])).canUnpublishAll).toBe(true)
    expect(menu(publishingState([version(1)], [WHOLE_RECORD])).canUnpublishAll).toBe(false)
  })

  it("changes and cancels a schedule rather than setting a second one", () => {
    const state = publishingState([version(1, { scheduled_locales: { [WHOLE_RECORD]: DUE_AT } })], [WHOLE_RECORD])
    expect(menu(state).scheduled).toBe(true)
  })

  it("has no per-language items on a model that publishes as a whole", () => {
    const state = publishingState([published(1)], [WHOLE_RECORD])
    expect(panelModel({ state }).language).toBeNull()
    expect(menu(state).canUnpublishOne).toBe(false)
  })

  it("offers Publish all languages and Schedule while any language has something to publish", () => {
    const EN_FR = ["en", "fr"]
    expect(menu(publishingState([published(1, ["en"])], EN_FR), EN_FR).canPublishAll).toBe(true)
    expect(menu(publishingState([published(1, EN_FR)], EN_FR), EN_FR).canPublishAll).toBe(false)
  })

  it("offers Unpublish in a language only while that language is live", () => {
    const enOnly = publishingState([published(1, ["en"])], ["en", "fr"])
    expect(menu(enOnly, ["en", "fr"], "en").canUnpublishOne).toBe(true)
    expect(menu(enOnly, ["en", "fr"], "fr").canUnpublishOne).toBe(false)
    // Unpublish all languages still works from French: English is live.
    expect(menu(enOnly, ["en", "fr"], "fr").canUnpublishAll).toBe(true)
  })
})
