// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { ApiCorsSettings } from "../src/views/ApiCorsSettings.js"
import { isArrayOf, isShape, isString } from "../src/lib/json.js"
import { elementOf, testClient } from "./support.js"

/**
 * SHb: the browser origins a production server allows are a project setting. This page shows what
 * the gateway enforces and where each origin comes from, and lets an owner or admin add, remove and
 * reset. The server is the authority: the page sends the whole list and shows what comes back.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

const DEFAULT = {
  origins: ["https://app.example.com", "https://admin.example.com"],
  source: "default",
  default: ["https://app.example.com", "https://admin.example.com"],
  siteOrigin: "https://app.example.com",
  configured: ["https://admin.example.com"],
  platform: [],
  saved: null,
  updatedAt: null,
  mode: "standalone",
  enforced: true,
  editable: true,
}

interface Call { url: string; method: string; body: unknown }

const isOriginsBody = isShape({ origins: isArrayOf(isString) })

/** The server's answer to a save: the list it was sent, now in force. */
function savedAnswer(call: Call): unknown {
  if (call.method !== "PUT") return DEFAULT
  if (!isOriginsBody(call.body)) throw new Error(`the save sent no origins list: ${JSON.stringify(call.body)}`)
  return { ...DEFAULT, source: "saved", saved: call.body.origins, origins: call.body.origins }
}

let root: Root | null = null
let container: HTMLElement
let calls: Call[] = []

async function render(permissions: Record<string, boolean>, answer: (call: Call) => unknown): Promise<void> {
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/studio/auth/verify")) return Response.json({ sub: "u1", role: "admin", permissions })
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    const call = { url, method: init?.method ?? "GET", body }
    calls.push(call)
    return Response.json(answer(call))
  })
  container = document.createElement("div")
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <AdminClientContext.Provider value={CLIENT}>
        <ApiCorsSettings />
      </AdminClientContext.Provider>,
    ),
  )
  for (let i = 0; i < 5; i++) await act(async () => {})
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label)
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe("the Allowed origins page", () => {
  it("reads the gateway's list beside the membership API and says where each origin comes from", async () => {
    await render({ manageDomains: true }, () => DEFAULT)
    expect(calls[0]).toMatchObject({ url: "http://localhost:8000/admin/cors-origins", method: "GET" })
    const text = container.textContent ?? ""
    expect(text).toContain("https://app.example.com")
    expect(text).toContain("Site URL")
    expect(text).toContain("Config")
  })

  it("adds an origin by saving the whole list", async () => {
    await render({ manageDomains: true }, savedAnswer)
    const input = elementOf(container, "input", HTMLInputElement)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, "https://partner.example")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) })
    for (let i = 0; i < 3; i++) await act(async () => {})

    const put = calls.find((c) => c.method === "PUT")
    // The site URL is left out: the server allows it whatever is saved (SHc).
    expect(put?.body).toEqual({ origins: ["https://admin.example.com", "https://partner.example"] })
    expect(container.textContent).toContain("Saved here")
    expect(button("Reset to default")).toBeDefined()
  })

  it("asks, then resets with a DELETE", async () => {
    await render({ manageDomains: true }, (call) => (call.method === "DELETE" ? DEFAULT : { ...DEFAULT, source: "saved", saved: DEFAULT.origins }))
    await act(async () => { button("Reset to default")!.click() })
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("Reset allowed origins to the default?")
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    await act(async () => { button("Reset origins")?.click() })
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(calls.some((c) => c.method === "DELETE")).toBe(true)
    expect(button("Reset to default")).toBeUndefined()
  })

  it("offers no changes to a role without manageDomains", async () => {
    await render({ schemaView: true }, () => DEFAULT)
    expect(container.querySelector("input")).toBeNull()
    expect(button("Remove")).toBeUndefined()
    expect(container.textContent).toContain("Owners and admins can change this list.")
  })

  it("says when dev mode is allowing every origin anyway", async () => {
    await render({ manageDomains: true }, () => ({ ...DEFAULT, mode: "dev", enforced: false }))
    expect(container.textContent).toContain("dev mode, which allows every origin")
  })

  it("shows the server's refusal verbatim", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "invalid origin" }), { status: 400 }))
    container = document.createElement("div")
    root = createRoot(container)
    await act(async () => root!.render(<AdminClientContext.Provider value={CLIENT}><ApiCorsSettings /></AdminClientContext.Provider>))
    for (let i = 0; i < 5; i++) await act(async () => {})
    expect(container.textContent).toContain("invalid origin")
  })
})

describe("the site URL on the Allowed origins page (SHc)", () => {
  it("stays marked as the site URL, with no Remove, while a saved list is in force", async () => {
    const saved = {
      ...DEFAULT,
      source: "saved",
      saved: ["https://partner.example"],
      origins: ["https://app.example.com", "https://partner.example"],
    }
    await render({ manageDomains: true }, () => saved)
    const rows = [...container.querySelectorAll("code")].map((c) => c.closest("div")?.parentElement)
    const siteRow = rows.find((r) => r?.textContent?.includes("https://app.example.com"))
    expect(siteRow?.textContent).toContain("Site URL")
    expect([...(siteRow?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Remove")).toBe(false)
  })

  it("leaves the site URL out of what it saves, since the server always allows it", async () => {
    const saved = { ...DEFAULT, source: "saved", saved: ["https://partner.example"], origins: ["https://app.example.com", "https://partner.example"] }
    await render({ manageDomains: true }, () => saved)
    await act(async () => { button("Remove")!.click() })
    for (let i = 0; i < 3; i++) await act(async () => {})
    // A browser app on that origin stops working the moment it goes, so the click only asks.
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("Stop allowing https://partner.example?")
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
    await act(async () => { button("Remove origin")?.click() })
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ origins: [] })
  })
})
