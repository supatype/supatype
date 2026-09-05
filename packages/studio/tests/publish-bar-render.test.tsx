import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PublishBar } from "../src/components/PublishBar.js"
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

describe("the publish bar", () => {
  it("renders a single row for a model with no localized field", () => {
    // Nobody without translations should have to read a locale column.
    const html = render(
      <PublishBar model={model()} recordId="r1" savedAt={0} seesDrafts onNavigate={() => {}} />,
    )
    expect(html).toContain("Publishing")
    expect(html).toContain("This record")
    expect(html).not.toContain(">en<")
  })

  it("renders a row per locale when a field is localized", () => {
    const html = render(
      <PublishBar
        model={model({
          versions: {
            drafts: true,
            keep: 20,
            versionsTable: "posts_versions",
            localizedColumns: ["body"],
          },
        })}
        recordId="r1"
        savedAt={0}
        seesDrafts
        onNavigate={() => {}}
      />,
    )
    expect(html).toContain("en")
    expect(html).toContain("fr")
    expect(html).not.toContain("This record")
  })

  it("says nothing at all for a model that keeps no versions", () => {
    // Not an empty card: a model with no publishing has no publishing bar.
    const html = render(
      <PublishBar
        model={model({ versions: null })}
        recordId="r1"
        savedAt={0}
        seesDrafts
        onNavigate={() => {}}
      />,
    )
    expect(html).toBe("")
  })

  it("says nothing for an audit model, which withholds no writes", () => {
    const html = render(
      <PublishBar
        model={model({
          versions: {
            drafts: false,
            keep: 20,
            versionsTable: "posts_versions",
            localizedColumns: [],
          },
        })}
        recordId="r1"
        savedAt={0}
        seesDrafts
        onNavigate={() => {}}
      />,
    )
    expect(html).toBe("")
  })

  it("offers a share control, since the link is the point of the feature", () => {
    const html = render(
      <PublishBar model={model()} recordId="r1" savedAt={0} seesDrafts onNavigate={() => {}} />,
    )
    expect(html).toContain("Share a preview")
  })

  it("shows nothing to a caller who does not see drafts", () => {
    // Row level security cannot enforce this here: Studio's data plane goes through the proxy with
    // the service role, which bypasses policies. A project that narrows draft visibility relies on
    // this being the place the narrowing binds.
    const html = render(
      <PublishBar
        model={model()}
        recordId="r1"
        savedAt={0}
        seesDrafts={false}
        onNavigate={() => {}}
      />,
    )
    expect(html).toBe("")
  })

  it("hides itself until capability resolves, rather than showing and retracting", () => {
    // `seesDrafts` starts false and becomes true once the server answers. Failing closed for that
    // moment is right: the alternative flashes draft controls at someone who may not have them.
    const html = render(
      <PublishBar
        model={model()}
        recordId="r1"
        savedAt={0}
        seesDrafts={false}
        onNavigate={() => {}}
      />,
    )
    expect(html).not.toContain("Publishing")
  })
})

describe("the schedule control", () => {
  it("stays out of the way until someone asks to schedule", () => {
    // The bar answers "what does the world see". A date picker open on every unpublished locale is
    // not an answer, it is a form nobody asked for, and a record with two locales opened with two.
    const html = renderToStaticMarkup(
      <ScheduleControl scheduledFor={null} busy={false} onSchedule={() => {}} onCancel={() => {}} />,
    )
    expect(html).toContain("Schedule instead")
    expect(html).not.toContain("datetime-local")
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
