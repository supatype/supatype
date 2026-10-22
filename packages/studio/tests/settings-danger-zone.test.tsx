// @vitest-environment jsdom
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { Settings } from "../src/views/Settings.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { PlatformCtx } from "../src/hooks/usePlatform.js"
import { isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * C23 (fresh-test): Settings had a Danger Zone whose Confirm Reset and Confirm Delete had no click
 * handler, and whose Delete asked for "DELETE my-project" whatever the project was called. Neither
 * act exists, so the tab is gone rather than offering controls that do nothing.
 */

isolateEachTest()

describe("the Settings tabs", () => {
  it("offer no Danger Zone, whose reset and delete do not exist", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}))
    const { container } = await mount(
      <PlatformCtx.Provider value={{ platformUrl: undefined, projectRef: undefined }}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <Settings />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </PlatformCtx.Provider>,
    )
    await settle()
    const tabs = [...container.querySelectorAll("button")].map((b) => b.textContent)
    expect(tabs).toContain("General")
    expect(tabs).not.toContain("Danger Zone")
  })
})
