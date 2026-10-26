// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { JumpToSearch } from "../src/components/JumpToSearch.js"
import { searchColumns } from "../src/lib/postgrest-search.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * Jump to on a model with localized fields. Kitchen-sink's Page title and Sponsor blurb are JSON
 * per locale, and Jump to sent `title.ilike...` for them, which Postgres refuses (`operator does not
 * exist: jsonb ~~* unknown`), so neither model was ever found. Stubbed like PostgREST: a text match
 * on a JSON column is that error.
 */

const PAGE = testModel({
  name: "page",
  label: "Page",
  labelPlural: "Pages",
  tableName: "page",
  searchFields: ["title", "body", "views"],
  fields: [
    testField({ name: "title", localized: true }),
    testField({ name: "body", widget: "richtext", localized: true }),
    testField({ name: "views", widget: "number" }),
  ],
})
const CONFIG = testConfig({
  models: [PAGE],
  locale: { locales: [{ code: "en", label: "English" }, { code: "fr", label: "French" }], defaultLocale: "en" },
})
const ROW = { id: "p1", title: { en: "Kitchen Sink Conference", fr: "Conférence" } }

let root: Root | null = null
let container: HTMLElement
let pageQueries: URL[] = []

/** PostgREST's answer: a text match on a JSON or number column is an error, a JSON path is text. */
function page(url: URL): Response {
  pageQueries.push(url)
  const or = url.searchParams.get("or") ?? ""
  if (/(^|[(,])(title|body|views)\.ilike/.test(or)) {
    return Response.json({ code: "42883", message: "operator does not exist: jsonb ~~* unknown" }, { status: 404 })
  }
  return Response.json([ROW], { headers: { "Content-Range": "0-0/1" } })
}

function stubFetch(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  pageQueries = []
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw)
    if (url.pathname.endsWith("/rest/v1/page")) return page(url)
    if (url.pathname.endsWith("/auth/v1/admin/users")) return Response.json({ users: [] }, { headers: { "X-Total-Count": "0" } })
    return Response.json({})
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)) })
}

async function search(value: string): Promise<void> {
  stubFetch()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/"]}>
        <AdminConfigContext.Provider value={CONFIG}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <JumpToSearch />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  const input = container.querySelector<HTMLInputElement>("input[type=text]")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    input?.focus()
    setter?.call(input, value)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle(350)
}

describe("Jump to on a localized model", () => {
  it("finds a page by its title in any locale, named in the default locale", async () => {
    await search("kitchen")
    expect(pageQueries[0]?.searchParams.get("or")).toBe('(title->>en.ilike."%kitchen%",title->>fr.ilike."%kitchen%")')
    const found = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "")
    expect(found.some((text) => text.includes("Kitchen Sink Conference"))).toBe(true)
  })
})

describe("the columns a search matches on", () => {
  it("leaves out what ilike cannot read and keeps a name it has no field for", () => {
    expect(searchColumns(PAGE.fields, ["title", "body", "views", "legacy"], ["en"])).toEqual(["title->>en", "legacy"])
  })
})
