// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import type { SupatypeClient } from "@supatype/client"
import { StudioCore } from "../src/StudioCore.js"
import type { AdminConfig } from "../src/config.js"
import type { PlatformContext } from "../src/hooks/usePlatform.js"

/**
 * The Realtime Inspector and its settings are not built, on Cloud or self-host: Cloud's pages were
 * UI over stubs (a connection count that is always 0, a broadcast to an endpoint that does not
 * exist, settings nothing reads), and self-host was shown a Cloud upsell for them. Until the
 * Inspector ships the page says it is coming, with no Cloud claim on either. Its nav entries are
 * pinned with the other unbuilt ones, in coming-soon-labels.test.tsx.
 */
const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined }
const CLOUD: PlatformContext = { platformUrl: "https://api.example.test", projectRef: "abc123" }

const CONFIG: AdminConfig = { models: [], globals: [] } as unknown as AdminConfig
/** Enough of a client for the shell to mount: signed out, and never answering. */
const CLIENT = {
  url: "http://localhost:8000",
  auth: {
    getSession: () => new Promise(() => {}),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  },
} as unknown as SupatypeClient

/** The whole Studio at `/realtime`, rendered as the browser renders it (the shell uses portals). */
async function page(platform: PlatformContext): Promise<string> {
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/realtime"]}>
        <StudioCore
          config={CONFIG}
          client={CLIENT}
          {...(platform.platformUrl !== undefined && { platformUrl: platform.platformUrl })}
          {...(platform.projectRef !== undefined && { projectRef: platform.projectRef })}
        />
      </MemoryRouter>,
    ),
  )
  const html = container.innerHTML
  act(() => root.unmount())
  return html
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The shell asks the server for things as it mounts; nothing here needs an answer.
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}))
})

describe.each([
  ["self-host", SELF_HOST],
  ["cloud", CLOUD],
])("the Realtime Inspector, on %s", (_name, platform) => {
  it("says it is coming soon, and offers nothing that does not work", async () => {
    const html = await page(platform)
    expect(html).toContain("Realtime Inspector")
    expect(html).toContain("coming soon")
    expect(html).not.toContain("Broadcast Tester")
    expect(html).not.toContain("Active Connections")
  })

  it("makes no Cloud claim", async () => {
    const html = await page(platform)
    expect(html).not.toContain("Supatype Cloud")
    expect(html).not.toContain("Available on")
  })
})
