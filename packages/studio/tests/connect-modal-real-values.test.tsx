// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConnectModal } from "../src/components/ConnectModal.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { ConnectionCtx, type ProjectConnection } from "../src/hooks/useConnection.js"
import { testClient } from "./support.js"

/**
 * The Connect panel printed `your-project-url` and `your-anon-key` in the env file. A new Cloud
 * user copying it got placeholders. It now shows the project's public API URL and anon key when the
 * host gives them, falls back to what a self-host Studio was injected with, and labels a
 * placeholder as one. The service role key never appears.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })
const REAL: ProjectConnection = { apiUrl: "https://kxv4m2np.supatype.io", anonKey: "anon.real.jwt" }
const SERVICE_KEY = "service.role.secret"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", async () => Response.json({ direct: null, pooler: null }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, "__SUPATYPE_CLOUD__")
})

function openPanel(connection?: ProjectConnection): void {
  act(() => {
    root.render(
      <AdminClientContext.Provider value={CLIENT}>
        <ConnectionCtx.Provider value={connection}>
          <ConnectModal open onClose={() => undefined} />
        </ConnectionCtx.Provider>
      </AdminClientContext.Provider>,
    )
  })
}

function code(): string {
  return Array.from(document.body.querySelectorAll("pre")).map((pre) => pre.textContent ?? "").join("\n")
}

function chooseFramework(id: string): void {
  const select = document.body.querySelector("select")
  if (!select) throw new Error("no framework select")
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
    setter?.call(select, id)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("the Connect panel's real values", () => {
  it("renders the given API URL and anon key in the env file", () => {
    openPanel(REAL)
    expect(code()).toContain("NEXT_PUBLIC_SUPATYPE_URL=https://kxv4m2np.supatype.io")
    expect(code()).toContain("NEXT_PUBLIC_SUPATYPE_ANON_KEY=anon.real.jwt")
    expect(code()).not.toContain("your-project-url")
    expect(code()).not.toContain("your-anon-key")
  })

  it("puts the real values in the plain JavaScript snippet instead of YOUR_ placeholders", () => {
    openPanel(REAL)
    chooseFramework("vanilla")
    expect(code()).toContain("url: 'https://kxv4m2np.supatype.io'")
    expect(code()).toContain("anonKey: 'anon.real.jwt'")
    expect(code()).toContain("SUPATYPE_URL=https://kxv4m2np.supatype.io")
    expect(code()).not.toContain("YOUR_SUPATYPE")
  })

  it("falls back to the values a self-host Studio was injected with", () => {
    Object.assign(window, {
      __SUPATYPE_CLOUD__: { url: "http://localhost:8000", anonKey: "anon.injected", serviceRoleKey: SERVICE_KEY },
    })
    openPanel()
    expect(code()).toContain("NEXT_PUBLIC_SUPATYPE_URL=http://localhost:8000")
    expect(code()).toContain("NEXT_PUBLIC_SUPATYPE_ANON_KEY=anon.injected")
    expect(code()).not.toContain(SERVICE_KEY)
  })

  it("labels the placeholders as placeholders when there is nothing better", () => {
    openPanel()
    expect(code()).toContain("SUPATYPE_URL=YOUR_SUPATYPE_URL")
    expect(code()).toContain("SUPATYPE_ANON_KEY=YOUR_SUPATYPE_ANON_KEY")
    expect(code()).toMatch(/# Replace/)
    expect(code()).not.toContain("your-project-url")
  })

  it("never shows the service role key, even when it is the only key the page has", () => {
    Object.assign(window, { __SUPATYPE_CLOUD__: { url: "http://localhost:8000", serviceRoleKey: SERVICE_KEY } })
    openPanel()
    expect(code()).not.toContain(SERVICE_KEY)
    expect(code()).toContain("SUPATYPE_ANON_KEY=YOUR_SUPATYPE_ANON_KEY")
  })

  it("never shows a given anon key that is really the service role key", () => {
    Object.assign(window, { __SUPATYPE_CLOUD__: { serviceRoleKey: SERVICE_KEY } })
    openPanel({ apiUrl: "https://x.supatype.io", anonKey: SERVICE_KEY })
    expect(code()).not.toContain(SERVICE_KEY)
  })
})
