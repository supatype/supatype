import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PublishBarBody } from "../src/components/PublishBar.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import type { LocaleState as UILocaleState } from "../src/hooks/useLocale.js"
import type { LocaleState, PublishingState } from "../src/lib/publishing.js"
import type { SupatypeClient } from "@supatype/client"

// The controls, rendered from state handed straight in.
//
// `PublishBar` learns its state from an effect, and this suite renders static markup on purpose, so
// no effect ever runs and the bar can only ever be seen in its empty first paint. Splitting the
// presentational half out is what makes the states below reachable at all: live, pending, scheduled
// and never-published each show a different set of controls, and which controls appear for which
// state is the whole of what this component decides.

const client = {
  url: "http://localhost:8000/studio/proxy",
  from: () => ({
    select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  }),
} as unknown as SupatypeClient

const locale = {
  currentLocale: "en",
  defaultLocale: "en",
  locales: [
    { code: "en", label: "English" },
    { code: "fr", label: "French" },
  ],
  setLocale: () => {},
} as unknown as UILocaleState

const noActions = {
  publishAll: () => {},
  publish: () => {},
  unpublish: () => {},
  schedule: () => {},
  cancelSchedule: () => {},
}

function state(locales: Record<string, LocaleState>, scheduled: Record<string, string> = {}): PublishingState {
  return {
    versions: [],
    newest: { scheduled_locales: scheduled } as unknown as PublishingState["newest"],
    hasPendingDraft: false,
    locales,
  }
}

function body(locales: Record<string, LocaleState>, scheduled?: Record<string, string>): string {
  return renderToStaticMarkup(
    <AdminClientContext.Provider value={client}>
      <LocaleContext.Provider value={locale}>
        <PublishBarBody
          record={{ modelTable: "posts", recordId: "r1", previewUrl: "https://example.com/p/x" }}
          view={{
            locales: Object.keys(locales),
            wholeRecord: false,
            state: state(locales, scheduled),
            busy: false,
            error: null,
          }}
          actions={noActions}
        />
      </LocaleContext.Provider>
    </AdminClientContext.Provider>,
  )
}

describe("which controls a locale offers", () => {
  it("offers nothing to publish or schedule for a locale already live", () => {
    // A locale showing the newest version has nothing waiting. Offering a date for it would promise
    // to publish something twice, and offering Publish would be a no-op dressed as an action.
    const html = body({ en: "live" })
    expect(html).not.toContain('aria-label="Publish en')
    expect(html).not.toContain('aria-label="Schedule en')
    expect(html).toContain('aria-label="Unpublish en')
  })

  it("offers nothing to unpublish for a locale that was never published", () => {
    const html = body({ en: "absent" })
    expect(html).toContain('aria-label="Publish en')
    expect(html).toContain('aria-label="Schedule en')
    expect(html).not.toContain('aria-label="Unpublish en')
  })

  it("offers everything for a locale with an edit waiting", () => {
    // Published, with a newer version not yet live: it can go live, be timed, or be withdrawn.
    const html = body({ en: "pending" })
    for (const label of ["Publish en", "Schedule en", "Unpublish en"]) {
      expect(html).toContain(`aria-label="${label}`)
    }
  })
})

describe("what a locale row says", () => {
  it("uses the short word on the row and keeps the sentence in the tooltip", () => {
    const html = body({ en: "pending" })
    expect(html).toContain(">Edit<")
    expect(html).toContain("newer edit not yet live")
  })

  it("shows a set time without anyone opening the picker", () => {
    // A schedule is a fact about the record, not a control somebody asked to see. Hiding it behind
    // the clock glyph would mean the only way to learn a post is timed is to go looking.
    const html = body({ en: "scheduled" }, { en: "2030-01-01T09:00:00Z" })
    expect(html).toContain("Goes live")
  })

  it("puts the set time in the schedule button's own label, not only its tooltip", () => {
    // The tooltip and the accessible name drifted apart once: the tooltip said a time was set and
    // the label did not, so screen reader users were the only people who could not find out.
    const html = body({ en: "scheduled" }, { en: "2030-01-01T09:00:00Z" })
    const at = html.indexOf('aria-label="Schedule en')
    expect(at).toBeGreaterThan(-1)
    expect(html.slice(at, html.indexOf('"', at + 20))).toContain("set for")
  })

  it("counts only what is not live in the publish-all button", () => {
    expect(body({ en: "live", fr: "absent" })).toContain("Publish 1 pending")
    expect(body({ en: "absent", fr: "absent" })).toContain("Publish 2 pending")
  })
})
