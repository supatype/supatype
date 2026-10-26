// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import { RecentBlock } from "../src/views/Dashboard.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * The Dashboard's recent list names each record by its title. Kitchen-sink's Page title is
 * localized, a JSON object per locale, and the list read `[object Object]`. Its links were plain
 * hrefs that left out Studio's base path, so they opened the app rather than the record.
 */

const PAGE = testModel({
  name: "page",
  tableName: "page",
  fields: [testField({ name: "title", localized: true })],
})
const CONFIG = testConfig({ models: [PAGE], locale: { locales: [{ code: "en", label: "English" }, { code: "fr", label: "French" }], defaultLocale: "en" } })
const LOCALE = { currentLocale: "fr", setLocale: () => {}, locales: CONFIG.locale?.locales ?? [], defaultLocale: "en" }

let root: Root | null = null
let container: HTMLElement

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", async () =>
    Response.json([
      { id: "p1", title: { en: "Kitchen Sink Conference", fr: "Conférence Kitchen Sink" } },
      { id: "p2", title: { en: "Venue" } },
    ]),
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter basename="/studio" initialEntries={["/studio/"]}>
        <AdminConfigContext.Provider value={CONFIG}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <LocaleContext.Provider value={LOCALE}>
              <RecentBlock block={{ id: "b", type: "recent", title: "Recent Pages", visible: true, model: "page" }} />
            </LocaleContext.Provider>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe("the Dashboard's recent records", () => {
  it("names a record by its localized title, in the current locale or the default", async () => {
    await render()
    const labels = Array.from(container.querySelectorAll("li a")).map((a) => a.textContent)
    expect(labels).toEqual(["Conférence Kitchen Sink", "Venue"])
    expect(container.textContent).not.toContain("[object Object]")
  })

  it("links to the record inside Studio", async () => {
    await render()
    expect(container.querySelector("li a")?.getAttribute("href")).toBe("/studio/models/page/p1")
  })
})
