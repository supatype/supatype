// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx } from "../src/hooks/usePlatform.js"
import { useProjectProxy, type ProjectProxy } from "../src/hooks/useProjectProxy.js"
import { testClient } from "./support.js"

// FF-25: Studio's Seeds page listed production's runs with Staging chosen. The project proxy's
// calls are raw fetches, which do not carry the client's own headers, so the environment the host
// says Studio is open on never reached them. It is now sent as X-Supatype-Environment, the header
// Cloud's proxy reads, on every call the proxy makes, Seeds included.

const CLIENT = testClient({ url: "/api/control-plane/projects/acme/proxy", token: "session-token" })

const sent: Array<{ url: string; headers: Headers }> = []

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  sent.length = 0
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    sent.push({ url, headers: new Headers(init?.headers) })
    return Response.json({ rows: [] })
  })
})

afterEach(() => vi.unstubAllGlobals())

/** Renders the hook under a host that says `environment` (or nothing) and hands back the proxy. */
async function proxyFor(environment: string | undefined): Promise<ProjectProxy> {
  let proxy: ProjectProxy | null = null
  function Probe(): null {
    proxy = useProjectProxy()
    return null
  }
  const root = createRoot(document.createElement("div"))
  await act(async () => {
    root.render(
      <PlatformCtx.Provider value={{ platformUrl: "/api/control-plane", projectRef: "acme", environment }}>
        <AdminClientContext.Provider value={CLIENT}>
          <Probe />
        </AdminClientContext.Provider>
      </PlatformCtx.Provider>,
    )
  })
  act(() => root.unmount())
  if (proxy === null) throw new Error("the hook did not render")
  return proxy
}

describe("the project proxy's environment", () => {
  it("is sent with the Seeds read when the host says Studio is open on staging", async () => {
    const proxy = await proxyFor("staging")
    await proxy.metadata("seeds")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe("/api/control-plane/projects/acme/proxy/metadata")
    expect(sent[0]!.headers.get("X-Supatype-Environment")).toBe("staging")
  })

  it("is sent with SQL as well, so one screen cannot read another environment than the next", async () => {
    const proxy = await proxyFor("preview")
    await proxy.sql("select 1")
    expect(sent[0]!.headers.get("X-Supatype-Environment")).toBe("preview")
  })

  it("is not sent when the host says nothing, as on a self-host Studio", async () => {
    const proxy = await proxyFor(undefined)
    await proxy.metadata("seeds")
    expect(sent[0]!.headers.has("X-Supatype-Environment")).toBe(false)
  })
})
