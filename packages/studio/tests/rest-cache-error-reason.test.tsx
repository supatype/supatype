// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RestCacheBrowser } from "../src/views/RestCacheBrowser.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { testClient, testConfig } from "./support.js"

/**
 * When the gateway's admin API refuses, the cache screen said only "The request failed (HTTP 503)."
 * and dropped the reason in the body. It now shows the reason, and a sentence a person can act on
 * for the one refusal that has a known fix.
 */

const client = testClient({ url: "http://localhost:8000/studio/proxy" })

let container: HTMLDivElement
let root: Root

function answerWith(status: number, body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })))
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

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <AdminClientContext.Provider value={client}>
        <AdminConfigContext.Provider value={testConfig()}>
          <RestCacheBrowser />
        </AdminConfigContext.Provider>
      </AdminClientContext.Provider>,
    )
  })
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe("the REST cache screen when the admin API refuses", () => {
  it("explains a missing keyspace in a sentence a person can act on", async () => {
    answerWith(503, { error: "keyspace not configured" })
    await render()
    expect(container.textContent).toContain("nowhere to store entries")
    expect(container.textContent).not.toContain("The request failed")
  })

  it("shows the server's reason and keeps the status for anything else", async () => {
    answerWith(502, { error: "connection refused by postgres" })
    await render()
    expect(container.textContent).toContain("connection refused by postgres (HTTP 502)")
  })

  it("shows the message of a feature refusal rather than its code", async () => {
    answerWith(403, { error: "rest_cache_not_available", message: "The response cache is not part of this plan." })
    await render()
    expect(container.textContent).toContain("The response cache is not part of this plan. (HTTP 403)")
  })

  it("keeps the bare status when the body says nothing readable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })))
    await render()
    expect(container.textContent).toContain("The request failed (HTTP 502).")
  })
})
