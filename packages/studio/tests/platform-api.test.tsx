// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import type { SupatypeClient } from "@supatype/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { usePlatformApi, type PlatformApi } from "../src/hooks/usePlatformApi.js"

// ST-1: Studio reaches the project's control plane the same way in both modes. Self-host goes
// through the Studio proxy with the session in the Authorization header, and asks once which
// project it serves; Cloud uses the platform URL it was given, with the session cookie.

const SELF_HOST_CLIENT = {
  url: "http://localhost:8000/studio/proxy",
  auth: { currentAccessToken: "studio-session-token" },
} as unknown as SupatypeClient

interface Call {
  url: string
  init: RequestInit | undefined
}
const calls: Call[] = []

function respond(url: string): Response {
  if (url.endsWith("/platform/v1/project")) return Response.json({ data: { ref: "acme" } })
  return Response.json({ data: { ok: true } })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return respond(url)
  })
})

afterEach(() => vi.unstubAllGlobals())

/** Render the hook, wait for it to settle, and hand back what it returned last. */
async function resolveApi(platform: PlatformContext): Promise<PlatformApi> {
  let latest: PlatformApi = { state: "loading" }
  function Probe(): null {
    latest = usePlatformApi()
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(async () => {
    root.render(
      <PlatformCtx.Provider value={platform}>
        <AdminClientContext.Provider value={SELF_HOST_CLIENT}>
          <Probe />
        </AdminClientContext.Provider>
      </PlatformCtx.Provider>,
    )
  })
  await act(async () => {})
  act(() => root.unmount())
  return latest
}

const header = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name)

describe("on self-host", () => {
  it("asks the control plane behind the Studio proxy which project it serves", async () => {
    const api = await resolveApi({ platformUrl: undefined, projectRef: undefined })
    expect(calls[0]?.url).toBe("http://localhost:8000/studio/proxy/platform/v1/project")
    expect(header(calls[0]?.init, "authorization")).toBe("Bearer studio-session-token")
    expect(api).toMatchObject({ state: "ready", mode: "self-host", projectRef: "acme" })
  })

  it("builds the project's routes from that answer, with the session header", async () => {
    const api = await resolveApi({ platformUrl: undefined, projectRef: undefined })
    if (api.state !== "ready") throw new Error("not ready")
    await api.fetch("realtime/channels")
    const last = calls[calls.length - 1]
    expect(last?.url).toBe("http://localhost:8000/studio/proxy/platform/v1/projects/acme/realtime/channels")
    expect(header(last?.init, "authorization")).toBe("Bearer studio-session-token")
  })

  it("is unavailable, with the status, when the control plane does not serve the project route", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }))
    expect(await resolveApi({ platformUrl: undefined, projectRef: undefined })).toEqual({ state: "unavailable", status: 404 })
  })
})

describe("on Cloud", () => {
  it("uses the platform URL and the session cookie, and asks nothing first", async () => {
    const api = await resolveApi({ platformUrl: "https://api.example.test/api/v1", projectRef: "abc123" })
    expect(calls).toEqual([])
    if (api.state !== "ready") throw new Error("not ready")
    expect(api.mode).toBe("cloud")
    await api.fetch("realtime/channels")
    expect(calls[0]?.url).toBe("https://api.example.test/api/v1/projects/abc123/realtime/channels")
    expect(calls[0]?.init?.credentials).toBe("include")
  })
})
