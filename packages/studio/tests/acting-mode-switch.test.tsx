// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { ElevatedModeBanner, ElevatedNoticeProvider, useShowsProjectRows } from "../src/components/ElevatedModeBanner.js"
import { studioAuthHeaders } from "../src/lib/studio-auth-headers.js"
import { proxyClientOptions } from "../src/components/StudioAccessGate.js"
import { chosenActingMode, type ActingMode } from "../src/lib/acting-mode.js"
import { testClient } from "./support.js"

/**
 * RX4 and the owner's decision of 2026-10-21: everyone acts as Studio by default, so their Studio
 * role decides what they may do with rows and the app's field rules still apply. Anyone who reads
 * content may switch to acting as themselves, to see the project as its own access rules show it to
 * them, and back; a role that may elevate may also switch to elevated access. Studio says which
 * mode is in force and sends the chosen mode on every request (`X-Supatype-Acting-Mode`).
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const READS = { read: true }

let root: Root | null = null
let container: HTMLElement
let verifyHeaders: Array<Record<string, string>> = []

interface Verify {
  role: string
  mode: ActingMode
  canElevate: boolean
  permissions: Record<string, boolean>
}

/** The headers a request carried, which Studio always passes as a plain object. */
function plainHeaders(init?: RequestInit): Record<string, string> {
  const headers = init?.headers ?? {}
  if (headers instanceof Headers || Array.isArray(headers)) {
    throw new Error("expected the verify request's headers as a plain object")
  }
  return { ...headers }
}

function stubVerify(verify: Verify): void {
  verifyHeaders = []
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    verifyHeaders.push(plainHeaders(init))
    return Response.json(verify)
  })
}

function ShowsRows(): null {
  useShowsProjectRows()
  return null
}

async function render(verify: Verify, onSwitched = vi.fn()): Promise<typeof onSwitched> {
  stubVerify(verify)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <AdminClientContext.Provider value={CLIENT}>
        <ElevatedNoticeProvider>
          <ShowsRows />
          <ElevatedModeBanner onSwitched={onSwitched} />
        </ElevatedNoticeProvider>
      </AdminClientContext.Provider>,
    )
  })
  return onSwitched
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label)
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the acting-mode switch", () => {
  it("tells an elevated admin so, and offers to act as themselves or as Studio", async () => {
    await render({ role: "admin", mode: "elevated", canElevate: true, permissions: READS })
    expect(container.textContent).toContain("Elevated access")
    expect(button("Act as myself")).toBeDefined()
    expect(button("Edit as Studio")).toBeDefined()
  })

  it("tells an admin acting as themselves so, and offers Studio and elevated access back", async () => {
    await render({ role: "admin", mode: "self", canElevate: true, permissions: READS })
    expect(container.textContent).toContain("Acting as yourself")
    expect(button("Use elevated access")).toBeDefined()
    expect(button("Edit as Studio")).toBeDefined()
  })

  // Owner decision 2026-10-21: an editor edits as Studio, so the app's row rules do not stop them,
  // and is told that the field rules still apply. They may preview the app's rules as themselves,
  // and are never offered elevated access.
  it("tells an editor they edit as Studio, and offers only acting as themselves", async () => {
    await render({ role: "editor", mode: "studio", canElevate: false, permissions: READS })
    expect(container.textContent).toContain("Editing as Studio")
    expect(container.textContent).toContain("masked fields stay masked")
    expect(button("Act as myself")).toBeDefined()
    expect(button("Use elevated access")).toBeUndefined()
  })

  it("offers an editor acting as themselves the way back to Studio, which forgets the choice", async () => {
    window.localStorage.setItem(`supatype.studio.actingMode:${PROXY}`, "self")
    const onSwitched = await render({ role: "editor", mode: "self", canElevate: false, permissions: READS })
    expect(container.textContent).toContain("Acting as yourself")
    await act(async () => button("Edit as Studio")!.click())
    expect(onSwitched).toHaveBeenCalledOnce()
    expect(chosenActingMode(PROXY)).toBeNull()
    expect(button("Use elevated access")).toBeUndefined()
  })

  it("says nothing to a role that reads no content", async () => {
    await render({ role: "billing", mode: "self", canElevate: false, permissions: {} })
    expect(container.textContent).toBe("")
  })

  it("remembers the choice, and sends it on every request from then on", async () => {
    const onSwitched = await render({ role: "admin", mode: "elevated", canElevate: true, permissions: READS })
    await act(async () => button("Act as myself")!.click())

    expect(onSwitched).toHaveBeenCalledOnce()
    expect(chosenActingMode(PROXY)).toBe("self")
    expect(studioAuthHeaders(CLIENT)["X-Supatype-Acting-Mode"]).toBe("self")
    const headers = proxyClientOptions("http://localhost:8000", "anon", null).headers
    expect(typeof headers === "function" ? headers()["X-Supatype-Acting-Mode"] : undefined).toBe("self")
  })

  it("asks verify for the chosen mode, so the mode shown is the mode in force", async () => {
    window.localStorage.setItem(`supatype.studio.actingMode:${PROXY}`, "self")
    await render({ role: "admin", mode: "self", canElevate: true, permissions: READS })
    expect(verifyHeaders[0]?.["X-Supatype-Acting-Mode"]).toBe("self")
  })
})
