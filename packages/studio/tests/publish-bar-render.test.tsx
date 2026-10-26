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
import type { RecordEditor } from "../src/hooks/usePublishActions.js"
import { testClient, testModel } from "./support.js"

// Typecheck says these components are well typed. It does not say they render: a hook called in the
// wrong place, a context read that throws, a `.map` over something that is undefined on the first
// pass all pass `tsc` and fail on screen. Rendering them once is cheap and catches that class
// outright.
//
// Static markup rather than a DOM: no effects run, which is the point. The first paint is what an
// editor sees before any data arrives, and it is the state most likely to be written without ever
// being looked at.

const client = testClient({ url: "http://localhost:8000/studio/proxy" })

const locale: LocaleState = {
  currentLocale: "en",
  defaultLocale: "en",
  locales: [
    { code: "en", label: "English" },
    { code: "fr", label: "French" },
  ],
  setLocale: () => {},
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return testModel({
    name: "Post",
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
  })
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <AdminClientContext.Provider value={client}>
      <LocaleContext.Provider value={locale}>{node}</LocaleContext.Provider>
    </AdminClientContext.Provider>,
  )
}

const editor: RecordEditor = {
  dirty: false,
  saving: false,
  savedAt: 0,
  onSave: () => {},
  persist: () => Promise.resolve(null),
  onChanged: () => {},
}

/** Every test in this file varies one or two props; the rest never change. */
function bar(over: { model?: ModelConfig; seesDrafts?: boolean } = {}): string {
  return render(publishBar(over))
}

function publishBar({ model: m = model(), seesDrafts = true }: { model?: ModelConfig; seesDrafts?: boolean }): React.ReactElement {
  return (
    <PublishBar
      record={{ model: m, recordId: "r1", title: "A post" }}
      editor={editor}
      seesDrafts={seesDrafts}
      onNavigate={() => {}}
    />
  )
}

describe("the publish bar", () => {
  // Static markup runs no effects, so every render here is the first paint: the version data has
  // not landed. What the panel shows once it has is in publish-bar-body.test.tsx, which renders the
  // presentational half with state handed straight in.

  it("shows a status before any data has loaded", () => {
    const html = bar()
    expect(html).toContain("Status")
    // Failing towards "draft" is the right way round: claiming a record is live before asking is
    // the one error that cannot be walked back.
    expect(html).toContain(">Draft<")
  })

  it("puts Save draft beside Publish, so saving plainly does not publish", () => {
    const html = bar()
    expect(html).toContain("Save draft")
    expect(html).toContain('aria-label="More publishing actions"')
  })

  it("reaches version history", () => {
    expect(bar()).toContain('aria-label="Version history"')
  })

  it("says nothing at all for a model that keeps no versions", () => {
    expect(bar({ model: model({ versions: null }) })).toBe("")
  })

  it("says nothing for an audit model, which withholds no writes", () => {
    expect(
      bar({
        model: model({
          versions: { drafts: false, keep: 20, versionsTable: "posts_versions", localizedColumns: [] },
        }),
      }),
    ).toBe("")
  })

  it("shows nothing to a caller who does not see drafts", () => {
    // Row level security cannot enforce this here: Studio's data plane goes through the proxy with
    // the service role, which bypasses policies. `seesDrafts` also starts false and becomes true
    // once the server answers, so this doubles as "fail closed while the capability resolves".
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
  function sidebar(publishing: React.ReactNode | undefined): string {
    return render(
      <EditFormSidebar
        {...(publishing !== undefined && { publishing })}
        previewAction={<button type="button">Live preview</button>}
        metaFields={[]}
        values={{}}
        onChange={() => {}}
        primaryKey="id"
        currentLocale="en"
        defaultLocale="en"
        recordSyncKey="r1"
        saving={false}
        onSave={() => {}}
        onDuplicate={() => {}}
        onDelete={() => {}}
      />,
    )
  }

  it("puts the status at the top of the sidebar, above the preview and the record's own actions", () => {
    const html = sidebar(publishBar({}))
    expect(html).toContain("st-edit-sidebar")
    expect(html.indexOf("Status")).toBeGreaterThan(-1)
    expect(html.indexOf("Status")).toBeLessThan(html.indexOf("Live preview"))
    expect(html.indexOf("Live preview")).toBeLessThan(html.indexOf("Duplicate"))
  })

  it("has one save on a drafts model: Save draft in the panel, no plain Save below", () => {
    const html = sidebar(publishBar({}))
    expect(html).toContain("Save draft")
    expect(html).not.toMatch(/>Save</)
    expect(html).toContain("Duplicate")
    expect(html).toContain("Delete")
  })

  it("keeps a plain Save for a model without drafts", () => {
    const html = sidebar(undefined)
    expect(html).toMatch(/>Save</)
    expect(html).not.toContain("Save draft")
    expect(html).not.toContain("Status")
  })
})