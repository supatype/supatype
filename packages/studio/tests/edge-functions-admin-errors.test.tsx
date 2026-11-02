// @vitest-environment jsdom
import React from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { SecondaryPanel } from "../src/components/SecondaryPanel.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { PlatformCtx } from "../src/hooks/usePlatform.js"
import { EdgeFunctions } from "../src/views/EdgeFunctions.js"
import { isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * A functions admin API that refuses is reported as a refusal, with its status and the server's own
 * words, never as an empty answer. Studio used to read any non-OK `/list` as "no functions": against
 * a server that did not serve the route, the view said "No functions deployed", the panel said "No
 * functions yet", and the Logs tab never mounted, so nothing on screen said what was wrong.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token", serviceRoleKey: "service" })
const HELLO = { name: "hello", invocations24h: 0, avgDurationMs: 0 }

type Answer = (path: string) => Response

isolateEachTest()

/** Answers each functions admin request by its path under /admin/v1/functions. */
function answering(answer: Answer): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    const path = new URL(url).pathname.replace(/^.*\/admin\/v1\/functions/, "")
    return answer(path)
  })
}

async function show(ui: React.ReactElement, answer: Answer, at: string): Promise<string> {
  answering(answer)
  const view = await mount(
    <MemoryRouter initialEntries={[at]}>
      <PlatformCtx.Provider value={{ platformUrl: undefined, projectRef: undefined }}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <Routes>
              <Route path="/edge-functions/:functionSlug/:tab" element={ui} />
              <Route path="*" element={ui} />
            </Routes>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </PlatformCtx.Provider>
    </MemoryRouter>,
  )
  await settle()
  return view.container.textContent ?? ""
}

const notFound = (): Response => Response.json({ message: "no such route" }, { status: 404, statusText: "Not Found" })

describe("the functions list", () => {
  it("reports a refused list with its status and the server's words, not as no functions", async () => {
    const text = await show(<EdgeFunctions />, notFound, "/edge-functions")
    expect(text).toContain("404")
    expect(text).toContain("no such route")
    expect(text).not.toContain("No functions deployed")
  })

  it("reports a refusal with no body by its status", async () => {
    const text = await show(<EdgeFunctions />, () => new Response("", { status: 502, statusText: "Bad Gateway" }), "/edge-functions")
    expect(text).toContain("502")
    expect(text).not.toContain("No functions deployed")
  })

  it("says there are no functions only when the server answered an empty list", async () => {
    const text = await show(<EdgeFunctions />, () => Response.json({ data: [] }), "/edge-functions")
    expect(text).toContain("No functions deployed")
  })
})

describe("a function's tabs", () => {
  it("reports a refused variable list, not an empty one", async () => {
    const answer: Answer = (path) =>
      path === "/list" ? Response.json({ data: [HELLO] })
      : Response.json({ message: "not allowed here" }, { status: 403 })
    const text = await show(<EdgeFunctions />, answer, "/edge-functions/hello/env")
    expect(text).toContain("403")
    expect(text).toContain("not allowed here")
    expect(text).not.toContain("No function environment variables")
  })

  it("reports refused logs, not an empty history", async () => {
    const answer: Answer = (path) =>
      path === "/list" ? Response.json({ data: [HELLO] })
      : path === "/logs/tail" ? new Response("", { status: 501 })
      : Response.json({ message: "log store down" }, { status: 500 })
    const text = await show(<EdgeFunctions />, answer, "/edge-functions/hello/logs")
    expect(text).toContain("500")
    expect(text).toContain("log store down")
    expect(text).not.toContain("No log entries found")
  })
})

describe("the functions panel", () => {
  it("does not claim there are no functions when the list was refused", async () => {
    const text = await show(<SecondaryPanel />, notFound, "/edge-functions")
    expect(text).not.toContain("No functions yet")
    expect(text).toContain("Could not load functions")
  })

  it("says there are none when the list is empty", async () => {
    const text = await show(<SecondaryPanel />, () => Response.json({ data: [] }), "/edge-functions")
    expect(text).toContain("No functions yet")
  })
})
