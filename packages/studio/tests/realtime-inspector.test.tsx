// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupatypeClient } from "@supatype/client"
import { StudioCore } from "../src/StudioCore.js"
import type { AdminConfig } from "../src/config.js"
import type { PlatformContext } from "../src/hooks/usePlatform.js"
import { TertiaryNav } from "../src/components/TertiaryNav.js"
import { StreamRows } from "../src/views/realtime/Stream.js"
import { ClientsTable } from "../src/views/realtime/Clients.js"
import { Broadcast } from "../src/views/realtime/Broadcast.js"
import { Stream } from "../src/views/realtime/Stream.js"
import { INITIAL_STREAM } from "../src/hooks/useRealtimeStream.js"
import type { InspectorApi } from "../src/views/realtime/InspectorTab.js"

/**
 * ST-3: the Realtime Inspector, built from the shared Studio components, shown only where this
 * deployment's control plane serves it, and never showing a redacted column as a stored null.
 */

const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLOUD: PlatformContext = { platformUrl: "https://api.example.test/api/v1", projectRef: "abc123" }
const CONFIG: AdminConfig = { models: [], globals: [] } as unknown as AdminConfig
const CLIENT = {
  url: "http://localhost:8000/studio/proxy",
  auth: {
    currentAccessToken: "token",
    getSession: () => new Promise(() => {}),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  },
} as unknown as SupatypeClient

interface Backend {
  role: string
  realtimeInspect: boolean
  /** Status of the inspector routes: what an older or newer control plane would answer. */
  inspector: number
}

const CHANNELS = { service: { ready: true, reason: null }, channels: [{ name: "room:lobby", subscribers: 2, presence: 0, targets: [], createdAt: "2026-10-12T20:00:00Z", lastEventAt: null }] }

function backend(b: Backend): (url: string) => Promise<Response> {
  return async (url) => {
    if (url.endsWith("/studio/auth/verify")) {
      return Response.json({ role: b.role, sub: "u1", permissions: { realtimeInspect: b.realtimeInspect } })
    }
    if (url.endsWith("/platform/v1/project")) {
      // Served by every Inspector-aware control plane, realtime on or off.
      const served = b.inspector === 200 || b.inspector === 501
      return served ? Response.json({ data: { ref: "acme" } }) : new Response("{}", { status: b.inspector })
    }
    if (url.includes("/realtime/channels")) {
      if (b.inspector === 200) return Response.json({ data: CHANNELS })
      return Response.json({ error: b.inspector === 501 ? "realtime_disabled" : "not_found", message: "no" }, { status: b.inspector })
    }
    return new Promise<Response>(() => {})
  }
}

let root: Root | null = null
let container: HTMLElement

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

async function studioAt(path: string, platform: PlatformContext, b: Backend): Promise<string> {
  vi.stubGlobal("fetch", backend(b))
  container = document.createElement("div")
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <StudioCore
          config={CONFIG}
          client={CLIENT}
          {...(platform.platformUrl !== undefined && { platformUrl: platform.platformUrl })}
          {...(platform.projectRef !== undefined && { projectRef: platform.projectRef })}
        />
      </MemoryRouter>,
    ),
  )
  await settle()
  return container.innerHTML
}

/** The page body, without the nav's own labels. */
function main(): string {
  return container.querySelector("main")?.innerHTML ?? ""
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe.each([
  ["self-host", SELF_HOST],
  ["cloud", CLOUD],
])("the Inspector on %s", (_name, platform) => {
  it("shows the channels when the control plane serves the Inspector", async () => {
    await studioAt("/realtime", platform, { role: "developer", realtimeInspect: true, inspector: 200 })
    expect(main()).toContain("room:lobby")
    expect(main()).not.toContain("coming soon")
  })

  it("says it is coming soon when the control plane does not serve it", async () => {
    await studioAt("/realtime", platform, { role: "admin", realtimeInspect: true, inspector: 404 })
    expect(main()).toContain("coming soon")
    expect(main()).not.toContain("Supatype Cloud")
  })

  it("explains realtime is off rather than failing", async () => {
    await studioAt("/realtime/channels", platform, { role: "admin", realtimeInspect: true, inspector: 501 })
    expect(main()).toContain("Realtime is off for this project")
  })
})

describe("roles", () => {
  it("hides the nav item and refuses the page for a role without realtimeInspect", async () => {
    const html = await studioAt("/realtime", SELF_HOST, { role: "editor", realtimeInspect: false, inspector: 403 })
    const nav = container.querySelector('[aria-label="Studio navigation"]')?.innerHTML ?? ""
    expect(nav).not.toContain('title="Realtime"')
    expect(nav).toContain('title="Edge Functions"')
    expect(main()).toContain("not available to your role")
    expect(html).not.toContain("room:lobby")
  })
})

describe("the stream", () => {
  it("shows a redacted column as redacted, never as null", async () => {
    vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}))
    container = document.createElement("div")
    root = createRoot(container)
    const state = {
      ...INITIAL_STREAM,
      rows: [{
        kind: "change" as const,
        change: {
          seq: 1, at: "2026-10-12T20:00:00Z", commitTimestamp: "t", schema: "public", table: "employee", event: "UPDATE" as const,
          deliveries: [{ connectionId: "7", channel: "emp", bytes: 120, payload: { old: null, new: { id: 1, salary: null } }, redacted: { old: [], new: ["salary"] } }],
          withheld: [], notMatched: 0,
        },
      }],
    }
    await act(async () => root!.render(<StreamRows state={state} />))
    await act(async () => container.querySelector("button")!.click())
    expect(container.textContent).toContain('"salary": redacted')
    expect(container.textContent).not.toContain('"salary": null')
    expect(container.textContent).toContain('"id": 1')
  })
})

describe("the clients count", () => {
  it("states the limit on Cloud and none on self-host", () => {
    const base = { connections: [], next: null }
    expect(renderToStaticMarkup(<ClientsTable data={{ ...base, total: 3, limit: null, tier: null }} />)).toContain("3 connections")
    expect(renderToStaticMarkup(<ClientsTable data={{ ...base, total: 3, limit: null, tier: null }} />)).not.toContain(" of ")
    expect(renderToStaticMarkup(<ClientsTable data={{ ...base, total: 3, limit: 500, tier: "pro" }} />)).toContain("3 of 500 connections")
  })
})

describe("tabs", () => {
  it("lists Settings and Metrics as coming in a later release", () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/realtime/channels"]}><TertiaryNav /></MemoryRouter>)
    for (const label of ["Channels", "Clients", "Stream", "Broadcast", "Settings", "Metrics"]) expect(html).toContain(label)
    expect((html.match(/Coming in a later release/g) ?? []).length).toBe(2)
  })
})

describe("controls", () => {
  it("builds every form control from the shared primitives", async () => {
    vi.stubGlobal("fetch", async () => new Promise<Response>(() => {}))
    const api: InspectorApi = { mode: "self-host", fetch: () => new Promise<Response>(() => {}) }
    container = document.createElement("div")
    root = createRoot(container)
    await act(async () => root!.render(<><Stream api={api} /><Broadcast api={api} /></>))
    const controls = [...container.querySelectorAll("select, textarea, input")]
    expect(controls.length).toBeGreaterThanOrEqual(7)
    for (const control of controls) expect(control.getAttribute("data-ui")).not.toBeNull()
  })
})
