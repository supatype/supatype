// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { ListView } from "../src/views/ListView.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import { anyFieldContains } from "../src/lib/postgrest-search.js"
import { testClient, testConfig, testModel } from "./support.js"

/**
 * A model's list searches every field the model names for search, on the server. It searched only
 * the first, so a record that matched on its second search field could not be found.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const MODEL = testModel({ name: "post", tableName: "posts", labelPlural: "Posts", searchFields: ["title", "slug"] })

let root: Root | null = null
let container: HTMLElement
let urls: URL[] = []

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe("a model's list search", () => {
  it("asks the server for rows matching any of the model's search fields", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    urls = []
    vi.stubGlobal("fetch", async (raw: string) => {
      urls.push(new URL(raw))
      return Response.json([])
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <AdminConfigContext.Provider value={testConfig({ models: [MODEL] })}>
            <AdminClientContext.Provider value={CLIENT}>
              <LocaleContext.Provider value={{ currentLocale: "en", setLocale: () => undefined, locales: [], defaultLocale: "en" }}>
                <ListView model={MODEL} onNavigate={() => undefined} />
              </LocaleContext.Provider>
            </AdminClientContext.Provider>
          </AdminConfigContext.Provider>
        </MemoryRouter>,
      )
    })
    const input = container.querySelector<HTMLInputElement>("input[placeholder^='Search posts']")
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    await act(async () => {
      if (input) setter?.call(input, "hello")
      input?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await settle()
    const last = urls.filter((u) => u.pathname.endsWith("/rest/v1/posts")).at(-1)
    expect(last?.searchParams.get("or")).toBe(`(${anyFieldContains(["title", "slug"], "hello")})`)
    expect(last?.searchParams.get("or")).toContain("slug.ilike")
  })
})

describe("anyFieldContains", () => {
  it("quotes the pattern so commas and parentheses in a search stay in it", () => {
    expect(anyFieldContains(["title"], "a,b)")).toBe('title.ilike."%a,b)%"')
  })

  it("reads % and _ in a search as themselves", () => {
    expect(anyFieldContains(["title"], "100%_x")).toBe(String.raw`title.ilike."%100\\%\\_x%"`)
  })
})
