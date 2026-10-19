// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PublishBar } from "../src/components/PublishBar.js"
import { ListView } from "../src/views/ListView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import type { ModelConfig } from "../src/config.js"
import { testClient, testField, testModel } from "./support.js"

/**
 * A record with no version rows, as a seed, an API insert or a save before 0.7.0 leaves it, shown
 * as its live row stands rather than as never published.
 *
 * Kitchen-sink's seeded talks were live under `published_at <= now()` with no version row, and
 * the editor called them "Not published" while the list gave them no badge at all, which reads as
 * live for a draft too.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })
const PAST = "2026-01-01T00:00:00Z"

const LOCALE: LocaleState = {
  currentLocale: "en",
  defaultLocale: "en",
  locales: [
    { code: "en", label: "English" },
    { code: "fr", label: "French" },
  ],
  setLocale: () => {},
}

const MODEL: ModelConfig = testModel({
  name: "Post",
  publishable: true,
  fields: [testField({ name: "title" })],
  listColumns: ["title"],
  versions: { drafts: true, keep: 20, versionsTable: "posts_versions", localizedColumns: ["body"] },
})

const LIVE = { id: "live", title: "Everywhere", published_at: PAST, body: { en: "Hi", fr: "Salut" } }
const PARTIAL = { id: "partial", title: "English only", published_at: PAST, body: { en: "Hi" } }
const DRAFT = { id: "draft", title: "Unseen", published_at: null, body: { en: "Hi" } }

let container: HTMLDivElement
let root: Root

/** Answers every history with no rows and the model's table with `rows`, as PostgREST would. */
function serve(rows: Record<string, unknown>[]): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/posts_versions")) return Response.json([])
    if (url.includes("/posts")) return Response.json(rows)
    return Response.json({})
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function show(node: React.ReactElement): Promise<string> {
  await act(async () =>
    root.render(
      <AdminClientContext.Provider value={CLIENT}>
        <LocaleContext.Provider value={LOCALE}>{node}</LocaleContext.Provider>
      </AdminClientContext.Provider>,
    ),
  )
  for (let i = 0; i < 5; i++) await act(async () => {})
  return container.textContent ?? ""
}

function bar(recordId: string): React.ReactElement {
  return <PublishBar model={MODEL} recordId={recordId} savedAt={0} seesDrafts onNavigate={() => {}} />
}

describe("the publish bar of a record with no history", () => {
  it("says live when its published row holds every language", async () => {
    serve([LIVE])
    const text = await show(bar("live"))
    expect(text).toContain("Live")
    expect(text).not.toContain("Not published")
  })

  it("says partly published when its published row holds one language of two", async () => {
    serve([PARTIAL])
    expect(await show(bar("partial"))).toContain("Partly published")
  })

  it("says not published when its row has no publish date", async () => {
    serve([DRAFT])
    expect(await show(bar("draft"))).toContain("Not published")
  })
})

describe("the list's state of records with no history", () => {
  it("badges each row as its live row stands", async () => {
    serve([LIVE, PARTIAL, DRAFT])
    await show(<ListView model={MODEL} onNavigate={() => {}} />)
    const badgeOf = (title: string): string => {
      const cell = Array.from(container.querySelectorAll("td")).find((td) => td.textContent?.startsWith(title))
      if (cell === undefined) throw new Error(`no row titled ${title}`)
      return cell.textContent?.slice(title.length) ?? ""
    }
    // Live needs no badge, as for a record with history.
    expect(badgeOf("Everywhere")).toBe("")
    expect(badgeOf("English only")).toBe("Partly published")
    expect(badgeOf("Unseen")).toBe("Not published")
  })
})
