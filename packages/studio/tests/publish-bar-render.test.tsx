import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PublishBar } from "../src/components/PublishBar.js"
import { EditFormSidebar } from "../src/components/EditFormSidebar.js"
import { ScheduleControl } from "../src/components/ScheduleControl.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import type { LocaleState } from "../src/hooks/useLocale.js"
import type { ModelConfig } from "../src/config.js"
import type { SupatypeClient } from "@supatype/client"

// Typecheck says these components are well typed. It does not say they render: a hook called in the
// wrong place, a context read that throws, a `.map` over something that is undefined on the first
// pass all pass `tsc` and fail on screen. Rendering them once is cheap and catches that class
// outright.
//
// Static markup rather than a DOM: no effects run, which is the point — the first paint is what an
// editor sees before any data arrives, and it is the state most likely to be written without ever
// being looked at.

const client = {
  url: "http://localhost:8000/studio/proxy",
  from: () => ({
    select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
  }),
} as unknown as SupatypeClient

const locale: LocaleState = {
  currentLocale: "en",
  defaultLocale: "en",
  locales: [
    { code: "en", label: "English" },
    { code: "fr", label: "French" },
  ],
  setLocale: () => {},
} as unknown as LocaleState

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: "Post",
    label: "Post",
    labelPlural: "Posts",
    tableName: "posts",
    primaryKey: "id",
    fields: [],
    listColumns: [],
    searchFields: [],
    publishable: true,
    versions: {
      drafts: true,
      keep: 20,
      versionsTable: "posts_versions",
      localizedColumns: [],
    },
    softDelete: false,
    timestamps: true,
    ...overrides,
  } as unknown as ModelConfig
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <AdminClientContext.Provider value={client}>
      <LocaleContext.Provider value={locale}>{node}</LocaleContext.Provider>
    </AdminClientContext.Provider>,
  )
}

/** Every test in this file varies one or two props; the rest never change. */
function bar(props: Partial<React.ComponentProps<typeof PublishBar>> = {}): string {
  return render(
    <PublishBar
      model={model()}
      recordId="r1"
      savedAt={0}
      seesDrafts
      onNavigate={() => {}}
      {...props}
    />,
  )
}

describe("the publish bar", () => {
  // Static markup runs no effects, so every render here is the first paint: the version data has
  // not landed. That is deliberately the state under test. What the controls do once it has is in
  // publish-bar-body.test.tsx, which renders the presentational half with state handed straight in.

  it("shows its heading and a summary before any data has loaded", () => {
    const html = bar()
    expect(html).toContain("Publishing")
    // Failing towards "not published" is the right way round: claiming a record is live before
    // asking is the one error that cannot be walked back.
    expect(html).toContain("Not published")
  })

  it("stays shut until it knows there is something to decide", () => {
    // Judging from the first paint, where nothing has loaded and every locale therefore reads as
    // unpublished, opened the section on every record and shut it again under the reader when a
    // fully published one answered. It also cost a preview-links request whose reply was discarded.
    // Anchored on the row label, which only the body renders. An earlier version of this looked for
    // "Publish 1 pending" and proved nothing: the default fixture is a whole-record model, whose
    // button reads just "Publish", so the assertion held with the section wide open.
    expect(bar()).not.toContain("This record")
  })

  it("is a real disclosure control, not a heading that happens to be clickable", () => {
    // `aria-expanded` on a button is what tells a screen reader this hides something.
    //
    // The *section's* button, specifically. A loose search for any button carrying `aria-expanded`
    // passed with this one stripped, because each locale's schedule toggle carries one too.
    const html = bar()
    const at = html.indexOf("Publishing")
    expect(at).toBeGreaterThan(-1)
    const opensAt = html.lastIndexOf("<button", at)
    expect(opensAt).toBeGreaterThan(-1)
    expect(html.slice(opensAt, html.indexOf(">", opensAt))).toContain("aria-expanded")
  })

  it("reaches version history without opening the section", () => {
    // History answers "what happened", which is a question somebody asks without intending to
    // publish anything. Burying it behind the disclosure would make it two clicks for no reason.
    expect(bar()).toContain('aria-label="Version history"')
  })

  it("says nothing at all for a model that keeps no versions", () => {
    // Not an empty card: a model with no publishing has no publishing bar. Nothing is rendered, so
    // there is also no heading left behind by the sidebar slot that holds it.
    expect(bar({ model: model({ versions: null }) })).toBe("")
  })

  it("says nothing for an audit model, which withholds no writes", () => {
    expect(
      bar({
        model: model({
          versions: {
            drafts: false,
            keep: 20,
            versionsTable: "posts_versions",
            localizedColumns: [],
          },
        }),
      }),
    ).toBe("")
  })

  it("shows nothing to a caller who does not see drafts", () => {
    // Row level security cannot enforce this here: Studio's data plane goes through the proxy with
    // the service role, which bypasses policies. A project that narrows draft visibility relies on
    // this being the place the narrowing binds.
    //
    // `seesDrafts` also starts false and becomes true once the server answers, so this doubles as
    // the "fail closed while the capability resolves" case: the alternative flashes draft controls
    // at someone who may not have them.
    expect(bar({ seesDrafts: false })).toBe("")
  })
})

describe("the schedule control", () => {
  it("shows the picker straight away, because the caller already asked", () => {
    // It used to own the decision to show itself and rendered a "Schedule instead" button when
    // closed. Once the locale row grew a clock glyph that mounts this, there were two disclosures
    // for one intent: clicking the clock revealed a button you had to click again to reach a date.
    const html = renderToStaticMarkup(
      <ScheduleControl scheduledFor={null} busy={false} onSchedule={() => {}} onCancel={() => {}} />,
    )
    expect(html).toContain("datetime-local")
    expect(html).not.toContain("Schedule instead")
  })

  it("shows the time and a way out when one is set", () => {
    const html = renderToStaticMarkup(
      <ScheduleControl
        scheduledFor="2026-10-01T09:00:00Z"
        busy={false}
        onSchedule={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain("Goes live")
    expect(html).toContain("Cancel")
    expect(html).not.toContain("datetime-local")
  })
})

describe("where publishing lives", () => {
  function sidebar(publishing: React.ReactNode): string {
    return render(
      <EditFormSidebar
        publishing={publishing}
        metaFields={[]}
        values={{}}
        onChange={() => {}}
        primaryKey="id"
        currentLocale="en"
        defaultLocale="en"
        recordSyncKey="r1"
        saving={false}
        onSave={() => {}}
      />,
    )
  }

  it("puts the publishing controls in the sidebar, above the record's own actions", () => {
    // It was a full-width banner above the form, which gave one model's workflow more visual weight
    // than the record being edited. In the sidebar it sits with the rest of the record's metadata.
    const html = sidebar(
      <PublishBar model={model()} recordId="r1" savedAt={0} seesDrafts onNavigate={() => {}} />,
    )
    expect(html).toContain("st-edit-sidebar")
    expect(html.indexOf("Publishing")).toBeGreaterThan(-1)
    expect(html.indexOf("Publishing")).toBeLessThan(html.indexOf("Save"))
  })

  it("leaves no empty section when the model has nothing to publish", () => {
    // The heading is the bar's own, not the slot's. A container that supplied it would render a
    // titled, empty "Publishing" block for every model that keeps no versions.
    const html = sidebar(
      <PublishBar
        model={model({ versions: null })}
        recordId="r1"
        savedAt={0}
        seesDrafts
        onNavigate={() => {}}
      />,
    )
    expect(html).not.toContain("Publishing")
  })
})
