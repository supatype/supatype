// @vitest-environment jsdom
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { Settings } from "../src/views/Settings.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { PlatformCtx } from "../src/hooks/usePlatform.js"
import { isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * The General tab offered a Save Changes button that kept nothing and said "Saved". No route changes
 * the project name or the site URL: they come from supatype.config.ts and SITE_URL. The tab now shows
 * what the stack reports and says where the rest is set.
 */

isolateEachTest()

interface Reported {
  projectName?: string
  siteUrl?: string
  appName?: string
}

async function renderGeneral(reported: Reported): Promise<HTMLElement> {
  vi.stubGlobal("fetch", async () => Response.json({}))
  const { appName, ...values } = reported
  const base = testConfig(values)
  const config = appName === undefined ? base : { ...base, branding: { ...base.branding, appName } }
  const { container } = await mount(
    <PlatformCtx.Provider value={{ platformUrl: undefined, projectRef: undefined }}>
      <AdminConfigContext.Provider value={config}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <Settings />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </PlatformCtx.Provider>,
  )
  await settle()
  return container
}

describe("the General settings tab", () => {
  it("has no Save Changes button, since nothing can be saved", async () => {
    const container = await renderGeneral({ projectName: "Acme" })
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent)
    expect(buttons).not.toContain("Save Changes")
  })

  it("shows the project name the stack reports, read-only", async () => {
    const container = await renderGeneral({ projectName: "Acme" })
    const input = [...container.querySelectorAll("input")].find((i) => i.value === "Acme")
    expect(input).toBeDefined()
    expect(input!.readOnly).toBe(true)
  })

  it("makes every field read-only and says where the site URL is set", async () => {
    const container = await renderGeneral({ projectName: "Acme", siteUrl: "https://acme.example.com" })
    const inputs = [...container.querySelectorAll("input")]
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs.every((i) => i.readOnly)).toBe(true)
    expect(container.textContent).toContain("SITE_URL")
    expect(container.textContent).toContain("supatype.config.ts")
  })

  it("shows the site URL the server reports, read-only", async () => {
    const container = await renderGeneral({ siteUrl: "https://acme.example.com" })
    const input = [...container.querySelectorAll("input")].find((i) => i.value === "https://acme.example.com")
    expect(input).toBeDefined()
    expect(input!.readOnly).toBe(true)
  })

  it("does not take a branding label for the project name", async () => {
    const container = await renderGeneral({ appName: "Brand Label" })
    expect([...container.querySelectorAll("input")].some((i) => i.value === "Brand Label")).toBe(false)
  })

  it("says where the name is set when the stack reports none", async () => {
    const container = await renderGeneral({})
    expect(container.textContent).toContain("supatype.config.ts")
  })
})
