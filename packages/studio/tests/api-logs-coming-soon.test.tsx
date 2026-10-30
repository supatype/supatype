// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import { isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * Nothing records API requests yet, so the API logs page has nothing to show. It used to mount a
 * log table with search and filters over a list that never filled, which read as a project nobody
 * had called. It says it is coming soon, as the other unbuilt log pages do.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

/** A server that signs the caller in as an admin who may view logs, and leaves the rest pending. */
function backend(url: string): Promise<Response> {
  if (url.endsWith("/studio/auth/verify")) {
    return Promise.resolve(Response.json({ role: "admin", sub: "u1", permissions: { viewLogs: true } }))
  }
  return new Promise<Response>(() => {})
}

isolateEachTest()

describe("the API logs page", () => {
  it("says request logging is coming soon instead of showing an empty log table", async () => {
    vi.stubGlobal("fetch", backend)
    const { container } = await mount(
      <MemoryRouter initialEntries={["/observability/logs/api"]}>
        <StudioCore config={testConfig()} client={CLIENT} />
      </MemoryRouter>,
    )
    await settle()
    const page = container.querySelector("main")?.innerHTML ?? ""

    expect(page).toContain("API Logs")
    expect(page).toContain("coming soon")
    expect(page).not.toContain("Search by path or request ID")
    expect(page).not.toContain("No request logs available yet")
  })
})
