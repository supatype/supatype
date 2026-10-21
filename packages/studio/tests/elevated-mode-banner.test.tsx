// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { ElevatedModeBanner, ElevatedNoticeProvider, useShowsProjectRows } from "../src/components/ElevatedModeBanner.js"
import type { ActingMode } from "../src/lib/acting-mode.js"
import { testClient } from "./support.js"

/**
 * Owner decision 2026-10-21: content screens have no acting-mode switch. Admins and developers work
 * with full access, which must never be silent, so the notice says so while project rows are on
 * screen. Editors and viewers act as Studio and have nothing to switch, so nothing is said to them.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const READS = { read: true }

let root: Root | null = null
let container: HTMLElement
let verifyHeaders: Headers[] = []

interface Verify {
  role: string
  mode: ActingMode
  canElevate: boolean
  permissions: Record<string, boolean>
}

function ShowsRows(): null {
  useShowsProjectRows()
  return null
}

async function render(verify: Verify): Promise<void> {
  verifyHeaders = []
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    verifyHeaders.push(new Headers(init?.headers))
    return Response.json(verify)
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <AdminClientContext.Provider value={CLIENT}>
        <ElevatedNoticeProvider>
          <ShowsRows />
          <ElevatedModeBanner />
        </ElevatedNoticeProvider>
      </AdminClientContext.Provider>,
    )
  })
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

describe("the full-access notice", () => {
  it("tells an admin that row rules do not apply to what they see, and offers no switch", async () => {
    await render({ role: "admin", mode: "elevated", canElevate: true, permissions: READS })
    expect(container.textContent).toContain("Full access")
    expect(container.textContent).toContain("Row Level Security does not apply")
    expect(container.querySelector("button")).toBeNull()
  })

  it("says nothing to an editor, who acts as Studio and has nothing to switch", async () => {
    await render({ role: "editor", mode: "studio", canElevate: false, permissions: READS })
    expect(container.textContent).toBe("")
  })

  it("says nothing to a role that reads no content", async () => {
    await render({ role: "billing", mode: "self", canElevate: false, permissions: {} })
    expect(container.textContent).toBe("")
  })

  it("asks verify for no mode, even with one left in storage, so the mode shown is the default in force", async () => {
    window.localStorage.setItem(`supatype.studio.actingMode:${PROXY}`, "self")
    await render({ role: "admin", mode: "elevated", canElevate: true, permissions: READS })
    expect(verifyHeaders[0]?.has("X-Supatype-Acting-Mode")).toBe(false)
  })
})
