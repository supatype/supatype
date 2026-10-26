// @vitest-environment jsdom
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { QuickActionsBlock } from "../src/views/Dashboard.js"
import { isolateEachTest, mount, settle, testClient, testConfig, testModel } from "./support.js"

/**
 * Fresh-test cosmetic: the dashboard's quick actions offered "+ Profile", "+ Author", "+ Tag" and
 * "+ Post" but not "+ Comment": the list stopped at the first four models. Every model is offered.
 */

isolateEachTest()

const NAMES = ["Profile", "Author", "Tag", "Post", "Comment"]

describe("the dashboard's quick actions", () => {
  it("offer to create every model, not only the first four", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ role: "admin", permissions: { write: true } }))
    const models = NAMES.map((name) => testModel({ name, label: name, tableName: name.toLowerCase() }))
    const { container } = await mount(
      <MemoryRouter>
        <AdminConfigContext.Provider value={testConfig({ models })}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <QuickActionsBlock />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
    await settle()
    const offered = [...container.querySelectorAll("a")].map((a) => a.textContent)
    expect(offered).toEqual(NAMES.map((n) => `+ ${n}`))
  })
})
