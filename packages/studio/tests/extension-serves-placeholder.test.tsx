// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import { withServedPages } from "../src/components/SecondaryPanel.js"
import { isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * Core Studio lists Backups as coming soon, which is true on self-host. Cloud has a real Backups page,
 * but registered it at its own path, so Cloud Studio showed both: a working page under "Cloud" and a
 * "Managed backups are coming soon" entry under Database. A host now serves the core path itself, its
 * page wins over the placeholder, and the nav stops calling it coming soon. A host that serves
 * nothing there is unchanged.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

function backend(url: string): Promise<Response> {
  if (url.endsWith("/studio/auth/verify")) {
    return Promise.resolve(Response.json({ role: "admin", sub: "u1", permissions: { databaseSchema: true } }))
  }
  return new Promise<Response>(() => {})
}

const HOST_BACKUPS = { routes: [{ path: "database/backups", element: <p>The host's own backups page</p> }] }

isolateEachTest()

describe("a page a host extension serves at a core path", () => {
  it("is what renders there, not the core placeholder", async () => {
    vi.stubGlobal("fetch", backend)
    const { container } = await mount(
      <MemoryRouter initialEntries={["/database/backups"]}>
        <StudioCore config={testConfig()} client={CLIENT} extensions={HOST_BACKUPS} />
      </MemoryRouter>,
    )
    await settle()
    const page = container.querySelector("main")?.innerHTML ?? ""
    expect(page).toContain("The host's own backups page")
    expect(page).not.toContain("Point-in-time recovery")
  })

  it("still shows the placeholder on a host that serves nothing there", async () => {
    vi.stubGlobal("fetch", backend)
    const { container } = await mount(
      <MemoryRouter initialEntries={["/database/backups"]}>
        <StudioCore config={testConfig()} client={CLIENT} />
      </MemoryRouter>,
    )
    await settle()
    expect(container.querySelector("main")?.innerHTML ?? "").toContain("Point-in-time recovery")
  })
})

describe("withServedPages", () => {
  const SECTION = {
    title: "Database",
    groups: [
      { label: "Tools", items: [{ label: "SQL Runner", href: "/database/sql" }] },
      {
        label: "Coming Soon",
        items: [
          { label: "Wrappers", href: "/database/wrappers", unavailable: { note: "not built" } },
          { label: "Backups", href: "/database/backups", unavailable: { note: "coming soon" } },
        ],
      },
    ],
  }

  it("moves a served page out of Coming Soon, available, and leaves the rest", () => {
    const out = withServedPages(SECTION, (href) => href === "/database/backups")
    expect(out.groups).toEqual([
      { label: "Tools", items: [{ label: "SQL Runner", href: "/database/sql" }, { label: "Backups", href: "/database/backups" }] },
      { label: "Coming Soon", items: [{ label: "Wrappers", href: "/database/wrappers", unavailable: { note: "not built" } }] },
    ])
  })

  it("changes nothing when the host serves none of them", () => {
    expect(withServedPages(SECTION, () => false)).toEqual(SECTION)
  })
})
