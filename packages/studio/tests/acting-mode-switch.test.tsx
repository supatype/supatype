// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { ElevatedModeBanner, ElevatedNoticeProvider, useShowsProjectRows } from "../src/components/ElevatedModeBanner.js"
import { studioAuthHeaders } from "../src/lib/studio-auth-headers.js"
import { proxyClientOptions } from "../src/components/StudioAccessGate.js"
import { chosenActingMode } from "../src/lib/acting-mode.js"
import { testClient } from "./support.js"

/**
 * RX4: an owner or admin acts elevated by default and may switch to acting as themselves, so they
 * can see a project as its own access rules show it to them. Studio shows the switch only to a role
 * that may elevate, says which mode is in force, and sends the chosen mode on every request
 * (`X-Supatype-Acting-Mode`). A developer, editor or viewer always acts as themselves and is offered
 * nothing to switch.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

let root: Root | null = null
let container: HTMLElement
let verifyHeaders: Array<Record<string, string>> = []

interface Verify {
  role: string
  mode: "self" | "elevated"
  canElevate: boolean
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
    return Response.json({ permissions: {}, ...verify })
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
  it("tells an elevated admin so, and offers to act as themselves", async () => {
    await render({ role: "admin", mode: "elevated", canElevate: true })
    expect(container.textContent).toContain("Elevated access")
    expect(button("Act as myself")).toBeDefined()
  })

  it("tells an admin acting as themselves so, and offers elevated access back", async () => {
    await render({ role: "admin", mode: "self", canElevate: true })
    expect(container.textContent).toContain("Acting as yourself")
    expect(button("Use elevated access")).toBeDefined()
  })

  it("offers a developer nothing to switch", async () => {
    await render({ role: "developer", mode: "self", canElevate: false })
    expect(container.textContent).toBe("")
  })

  it("remembers the choice, and sends it on every request from then on", async () => {
    const onSwitched = await render({ role: "admin", mode: "elevated", canElevate: true })
    await act(async () => button("Act as myself")!.click())

    expect(onSwitched).toHaveBeenCalledOnce()
    expect(chosenActingMode(PROXY)).toBe("self")
    expect(studioAuthHeaders(CLIENT)["X-Supatype-Acting-Mode"]).toBe("self")
    const headers = proxyClientOptions("http://localhost:8000", "anon", null).headers
    expect(typeof headers === "function" ? headers()["X-Supatype-Acting-Mode"] : undefined).toBe("self")
  })

  it("asks verify for the chosen mode, so the mode shown is the mode in force", async () => {
    window.localStorage.setItem(`supatype.studio.actingMode:${PROXY}`, "self")
    await render({ role: "admin", mode: "self", canElevate: true })
    expect(verifyHeaders[0]?.["X-Supatype-Acting-Mode"]).toBe("self")
  })
})
