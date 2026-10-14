// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeClient } from "@supatype/client"
import type { AdminConfig } from "../src/config.js"
import { Settings } from "../src/views/Settings.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"

/**
 * The Settings CORS tab is the allowed-origins page (SHb): it shows what the gateway enforces, read
 * from `/admin/cors-origins`, on self-host and Cloud alike. It used to say that Studio could not
 * read the list, and on Cloud it edited a project setting the gateway's own rule never consulted.
 */
const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CONFIG = { models: [], globals: [] } as unknown as AdminConfig
const CLIENT = { url: "http://localhost:8000/studio/proxy", auth: { currentAccessToken: "t" } } as unknown as SupatypeClient
const IN_FORCE = {
  origins: ["https://app.example.com"], source: "default", default: ["https://app.example.com"],
  siteOrigin: "https://app.example.com", configured: [], platform: [], saved: null, updatedAt: null,
  mode: "standalone", enforced: true, editable: true,
}

let container: HTMLDivElement
let root: Root
let requested: string[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  requested = []
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    return Response.json(url.endsWith("/cors-origins") ? IN_FORCE : {})
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function corsTab(platform: PlatformContext, demoMode = false): Promise<string> {
  await act(async () =>
    root.render(
      <PlatformCtx.Provider value={platform}>
        <AdminConfigContext.Provider value={CONFIG}>
          <AdminClientContext.Provider value={CLIENT}>
            <Settings demoMode={demoMode} />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </PlatformCtx.Provider>,
    ),
  )
  const tab = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "CORS")
  expect(tab, "the CORS tab").toBeDefined()
  await act(async () => tab!.click())
  for (let i = 0; i < 5; i++) await act(async () => {})
  return container.textContent ?? ""
}

describe("the CORS tab", () => {
  it("shows the origins the gateway enforces, read from its API", async () => {
    const text = await corsTab(SELF_HOST)
    expect(requested).toContain("http://localhost:8000/admin/cors-origins")
    expect(text).toContain("https://app.example.com")
    expect(text).toContain("Site URL")
  })

  it("makes no claim that an unset list is permissive", async () => {
    expect(await corsTab(SELF_HOST)).not.toMatch(/permissive/i)
  })

  it("in the demo build, says where the list comes from without asking a gateway", async () => {
    const text = await corsTab(SELF_HOST, true)
    expect(text).toContain("SUPATYPE_CORS_ALLOW_ORIGINS")
    expect(text).toContain("api.corsOrigins")
    expect(requested.filter((u) => u.endsWith("/cors-origins"))).toEqual([])
  })
})
