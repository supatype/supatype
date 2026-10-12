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
 * CORS on a self-hosted server: same-origin unless `SUPATYPE_CORS_ALLOW_ORIGINS` lists other
 * origins, read once when the server starts. Studio cannot edit or read that list, so the tab says
 * how to set it. It used to show a Cloud upsell instead, and the Cloud banner beside it says an
 * unset list is "a permissive default", which is true of Cloud and the opposite of self-host.
 */
const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CONFIG = { models: [], globals: [] } as unknown as AdminConfig
const CLIENT = { url: "http://localhost:8000" } as unknown as SupatypeClient

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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
  return container.textContent ?? ""
}

describe.each([
  ["self-host", false],
  ["demo mode", true],
])("the CORS tab, on %s", (_name, demoMode) => {
  it("says how to set the allow-list, since Studio cannot read it", async () => {
    const text = await corsTab(SELF_HOST, demoMode)
    expect(text).toContain("SUPATYPE_CORS_ALLOW_ORIGINS")
    expect(text).toContain(".env")
    expect(text).toContain("own origin")
  })

  it("makes no Cloud claim and no claim that unset is permissive", async () => {
    const text = await corsTab(SELF_HOST, demoMode)
    expect(text).not.toContain("Supatype Cloud")
    expect(text).not.toMatch(/permissive/i)
  })
})
