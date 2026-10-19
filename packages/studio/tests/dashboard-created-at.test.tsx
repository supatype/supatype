// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import type { ModelConfig } from "../src/config.js"
import { Dashboard } from "../src/views/Dashboard.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * The Dashboard reads `created_at` only from a model that has one as a date or time.
 *
 * Its per-day chart, "this week" count and Recent list all asked for `created_at` on the first
 * models, whatever they declared. A self-hosted project's Todo has a text `created_at`, so the chart's
 * function failed (`date_trunc(unknown, text)`, 404); a fresh project's Profile has none, so the
 * chart, the count and the list each answered 400 on every load.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const LOCALE = { currentLocale: "en", setLocale: () => {}, locales: [{ code: "en", label: "English" }], defaultLocale: "en" }

const PROFILE = testModel({ name: "Profile", label: "Profile", labelPlural: "Profiles", tableName: "profile", fields: [testField({ name: "display_name" })] })
const TODO = testModel({ name: "Todo", label: "Todo", labelPlural: "Todos", tableName: "todo", fields: [testField({ name: "created_at", widget: "text" })] })
const TALK = testModel({ name: "Talk", label: "Talk", labelPlural: "Talks", tableName: "talk", fields: [testField({ name: "created_at", widget: "datetime", readOnly: true })] })

let requests: string[] = []
let root: Root | null = null
let container: HTMLElement

/** The request's URL with its body, so an RPC's arguments can be read from the log. */
function logged(url: string, init?: RequestInit): string {
  return typeof init?.body === "string" ? `${url} ${init.body}` : url
}

async function mount(models: ModelConfig[]): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  requests = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push(logged(decodeURIComponent(url), init))
    return Response.json([])
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={testConfig({ models })}>
          <AdminClientContext.Provider value={CLIENT}>
            {/* The recent list names records in the current locale, as Studio's root provides. */}
            <LocaleContext.Provider value={LOCALE}>
              <Dashboard />
            </LocaleContext.Provider>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the Dashboard and created_at", () => {
  it("asks for no created_at on models without a date or time one", async () => {
    await mount([PROFILE, TODO])
    const modelReads = requests.filter((r) => r.includes("/rest/v1/profile") || r.includes("/rest/v1/todo"))
    expect(modelReads.length).toBeGreaterThan(0)
    expect(modelReads.filter((r) => r.includes("created_at"))).toEqual([])
    expect(requests.filter((r) => r.includes("daily_content_creates"))).toEqual([])
  })

  it("charts and orders by created_at on a model that has one", async () => {
    await mount([PROFILE, TALK])
    expect(requests.some((r) => r.includes("daily_content_creates") && r.includes('"table_name":"talk"'))).toBe(true)
    expect(requests.some((r) => r.includes("/rest/v1/talk") && r.includes("order=created_at.desc"))).toBe(true)
    expect(requests.some((r) => r.includes("/rest/v1/talk") && r.includes("created_at=gte."))).toBe(true)
  })
})
