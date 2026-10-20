// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import { PlatformCtx } from "../src/hooks/usePlatform.js"
import { Dashboard } from "../src/views/Dashboard.js"
import { EdgeFunctions } from "../src/views/EdgeFunctions.js"
import { MediaLibrary } from "../src/views/MediaLibrary.js"
import { RestCacheBrowser } from "../src/views/RestCacheBrowser.js"
import { Settings } from "../src/views/Settings.js"
import { renderBrowser, settle } from "./data-browser-support.js"
import { asking, press } from "./dialog-support.js"
import { testClient, testConfig } from "./support.js"

/**
 * Every Studio action that destroys something it cannot put back asks first, in Studio's own
 * dialog, and does nothing until the destructive answer. Each of these ran on the first click, or
 * asked through the browser's `confirm()`, which looks like a different product and cannot say
 * what the act means.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token", serviceRoleKey: "service" })

interface Call { url: string; method: string }

type Answer = (url: string, method: string) => Response

let root: Root | null = null
let container: HTMLElement
let calls: Call[] = []

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

/** Renders `ui` at `at` with the providers every view reads, answering requests with `answer`. */
async function mount(ui: React.ReactElement, answer: Answer, at = "/"): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  vi.stubGlobal("confirm", () => { throw new Error("window.confirm was called") })
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? "GET"
    calls.push({ url: decodeURIComponent(url), method })
    return answer(url, method)
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<Providers at={at}>{ui}</Providers>) })
  await settle()
}

function Providers({ at, children }: { at: string; children: React.ReactElement }): React.ReactElement {
  return (
    <MemoryRouter initialEntries={[at]}>
      <PlatformCtx.Provider value={{ platformUrl: undefined, projectRef: undefined }}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <LocaleContext.Provider value={{ currentLocale: "en", setLocale: () => undefined, locales: [], defaultLocale: "en" }}>
              <Routes>
                <Route path="/edge-functions/:functionSlug/:tab" element={children} />
                <Route path="*" element={children} />
              </Routes>
            </LocaleContext.Provider>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </PlatformCtx.Provider>
    </MemoryRouter>
  )
}

/** The `method` requests sent to a URL containing `target`. */
function writes(method: string, target: string): Call[] {
  return calls.filter((c) => c.method === method && c.url.includes(target))
}

/** Asserts `trigger` only asks `question`, and that `answer` then sends one `method` request to a URL containing `target`. */
async function expectAsksThen(trigger: string, question: string, answer: string, write: { method: string; target: string }): Promise<void> {
  await press(trigger)
  expect(asking()).toContain(question)
  expect(writes(write.method, write.target)).toEqual([])
  await press(answer)
  expect(asking()).toBeNull()
  expect(writes(write.method, write.target)).toHaveLength(1)
}

describe("the data browser", () => {
  it("asks before it deletes a row", async () => {
    const browser = await renderBrowser()
    try {
      const del = browser.container.querySelector<HTMLButtonElement>('button[title="Delete record"]')
      if (!del) throw new Error("no Delete record button")
      await act(async () => del.click())
      await settle()
      expect(asking()).toContain("Delete this record from message?")
    } finally {
      browser.unmount()
    }
  })
})

describe("the REST cache", () => {
  it("asks in Studio's dialog, not the browser's, before it flushes", async () => {
    await mount(<RestCacheBrowser tableFilter="posts" />, () => Response.json({ entries: [], cursor: "0" }))
    await expectAsksThen("Flush", "Flush every cache entry for posts?", "Flush cache", { method: "DELETE", target: "/admin/v1/cache?table=posts" })
  })
})

describe("an edge function's variables", () => {
  it("asks before it deletes one", async () => {
    const answer: Answer = (url) =>
      url.endsWith("/list") ? Response.json({ data: [{ name: "hello", invocations24h: 0, avgDurationMs: 0 }] })
      : url.endsWith("/hello/env") ? Response.json({ data: ["API_KEY"] })
      : Response.json({})
    await mount(<EdgeFunctions />, answer, "/edge-functions/hello/env")
    await expectAsksThen("Delete", "Delete API_KEY?", "Delete variable", { method: "DELETE", target: "/hello/env/API_KEY" })
  })
})

describe("the media library", () => {
  it("asks before it deletes a file", async () => {
    const at = "2026-10-19T10:00:00Z"
    const file = { id: "o1", bucket_id: "docs", name: "report.txt", owner: null, metadata: { size: 1, mimetype: "text/plain" }, created_at: at, updated_at: at, last_accessed_at: at, size: 1, mimetype: "text/plain" }
    const bucket = { id: "docs", name: "docs", public: false, file_size_limit: null, allowed_mime_types: null, created_at: at, updated_at: at }
    const answer: Answer = (url) =>
      url.endsWith("/storage/v1/bucket") ? Response.json([bucket])
      : url.includes("/storage/v1/object/list/docs") ? Response.json([file], { headers: { "X-Total-Count": "1" } })
      : Response.json([])
    await mount(<MediaLibrary />, answer)
    const select = container.querySelector<HTMLSelectElement>("select")
    if (!select) throw new Error("no bucket picker")
    await act(async () => {
      select.value = "docs"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await settle()
    expect(container.textContent).toContain("report.txt")
    await expectAsksThen("Delete", "Delete report.txt?", "Delete file", { method: "DELETE", target: "/storage/v1/object/docs" })
  })
})

describe("the dashboard's saved views", () => {
  it("asks before it deletes one", async () => {
    const view = (id: string, name: string, isDefault: boolean) => ({ id, name, is_default: isDefault, layout: [], created_by: null, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" })
    const answer: Answer = (url) => (url.includes("/dashboard_views") ? Response.json([view("v1", "Main", true), view("v2", "Ops", false)]) : Response.json([]))
    await mount(<Dashboard />, answer)
    await expectAsksThen("Delete", "Delete the Main view?", "Delete view", { method: "DELETE", target: "/dashboard_views?id=eq.v1" })
  })
})

describe("the database password", () => {
  it("asks before it rotates", async () => {
    const answer: Answer = (url) =>
      url.endsWith("/database/connection") ? Response.json({ direct: { host: "127.0.0.1", port: 5432, database: "supatype", user: "supatype_admin" }, pooler: null })
      : url.endsWith("/credentials/status") ? Response.json({ mode: "local", password_status: "available", can_reveal: true, generation: 1 })
      : Response.json({})
    await mount(<Settings />, answer)
    await press("Database")
    await expectAsksThen("Rotate Password", "Rotate the database password?", "Rotate password", { method: "POST", target: "/credentials/rotate" })
  })
})
