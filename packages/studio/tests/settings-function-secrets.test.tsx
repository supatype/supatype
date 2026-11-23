// @vitest-environment jsdom
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { Settings } from "../src/views/Settings.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { PlatformCtx } from "../src/hooks/usePlatform.js"
import { act, button, elementOf, isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * D-60b: the Environment tab was state held in the page, so nothing it showed was saved. It is the
 * project's function secrets: the names the server lists, set and removed through the functions
 * admin API, with no value ever shown again.
 */

isolateEachTest()

interface Call { path: string; method: string; body: unknown }

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

/** Answers the shared env routes from `names`, and records every request to them. */
function serveEnv(names: string[], refuse?: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const path = url.pathname.replace(/^.*\/admin\/v1\/functions/, "")
    const call: Call = { path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }
    if (!url.pathname.includes("/admin/v1/functions/env")) return Response.json({})
    calls.push(call)
    const refused = refuse?.(call)
    if (refused) return refused
    return call.method === "GET" ? Response.json({ data: names }) : Response.json({ data: { key: "k", message: "set" } })
  })
  return calls
}

async function openEnvironment(): Promise<HTMLElement> {
  const { container } = await mount(
    <PlatformCtx.Provider value={{ platformUrl: undefined, projectRef: undefined }}>
      <AdminConfigContext.Provider value={testConfig()}>
        <AdminClientContext.Provider value={CLIENT}>
          <Settings />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </PlatformCtx.Provider>,
  )
  await settle()
  await act(async () => { button(container, "Environment").click() })
  await settle()
  return container
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("the Environment tab", () => {
  it("lists the secret names the server holds, never a value", async () => {
    const calls = serveEnv(["STRIPE_KEY", "RESEND_KEY"])
    const container = await openEnvironment()
    expect(calls[0]).toMatchObject({ path: "/env", method: "GET" })
    const text = container.textContent ?? ""
    expect(text).toContain("STRIPE_KEY")
    expect(text).toContain("RESEND_KEY")
    expect(text).toContain("ctx.env")
    expect(text).toContain("next call")
  })

  it("posts a new secret and says Saved", async () => {
    const calls = serveEnv([])
    const container = await openEnvironment()
    await typeInto(elementOf(container, 'input[placeholder="KEY"]', HTMLInputElement), "API_TOKEN")
    await typeInto(elementOf(container, 'input[placeholder="value"]', HTMLInputElement), "s3cret")
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/env", body: { key: "API_TOKEN", value: "s3cret" } })
    expect(container.querySelector('[data-ui="saved-notice"]')?.textContent).toBe("Saved")
    expect(elementOf(container, 'input[placeholder="value"]', HTMLInputElement).value).toBe("")
  })

  it("removes a secret after asking", async () => {
    const calls = serveEnv(["STRIPE_KEY"])
    const container = await openEnvironment()
    await act(async () => { button(container, "Remove").click() })
    await act(async () => { button(document.body, "Remove secret").click() })
    await settle()
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ path: "/env/STRIPE_KEY" })
  })

  it("shows a refused set with its status and the server's words, and no Saved", async () => {
    serveEnv([], (c) => c.method === "POST" ? Response.json({ error: "key and value required" }, { status: 400, statusText: "Bad Request" }) : undefined)
    const container = await openEnvironment()
    await typeInto(elementOf(container, 'input[placeholder="KEY"]', HTMLInputElement), "X")
    await act(async () => { button(container, "Set secret").click() })
    await settle()
    const text = container.textContent ?? ""
    expect(text).toContain("400")
    expect(text).toContain("key and value required")
    expect(container.querySelector('[data-ui="saved-notice"]')).toBeNull()
  })

  it("shows a refused list instead of an empty page", async () => {
    serveEnv([], (c) => c.method === "GET" ? Response.json({ error: "no functions directory is configured" }, { status: 409, statusText: "Conflict" }) : undefined)
    const container = await openEnvironment()
    expect(container.textContent).toContain("409")
    expect(container.textContent).toContain("no functions directory is configured")
  })
})
