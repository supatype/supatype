// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { ConstraintsView } from "../src/views/database/ConstraintsView.js"
import { IndexesView } from "../src/views/database/IndexesView.js"
import { RolesView } from "../src/views/database/RolesView.js"
import { ExtensionsView } from "../src/views/database/ExtensionsView.js"
import { EmptyState } from "../src/components/EmptyState.js"
import { ErrorBanner } from "../src/components/ErrorBanner.js"
import { isolateEachTest, mount, settle, testClient } from "./support.js"

/**
 * The read-only Database screens (constraints, indexes, roles) are built from the shared
 * primitives, as the screens that write are: the shared schema Select, the shared placeholder rows
 * while loading, and a shared table card of Th and Td cells. The empty state's action and the error
 * banner's Retry are the shared Button, so every screen that shows them gets it too.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

/** One row every view can render. */
const ROW = {
  schema_name: "public", name: "orders_pkey", table_name: "orders", type: "PRIMARY KEY", definition: "PRIMARY KEY (id)",
  index_name: "orders_pkey", columns: "id", method: "btree", is_primary: true, is_unique: true, size: "8 kB",
  rolname: "app", rolcanlogin: true, rolconnlimit: -1, rolvaliduntil: null,
  extname: "pgcrypto", extversion: "1.3", description: null, default_version: "1.3", comment: "crypto",
}

/** Answers every request; with `hold`, leaves the catalogue reads unanswered so the view stays loading. */
function stubFetch(hold: boolean): void {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/studio/auth/verify")) {
      return Response.json({ role: "developer", mode: "self", canElevate: false, permissions: { sqlEditor: true, schemaView: true } })
    }
    if (hold) return new Promise<Response>(() => {})
    return Response.json({ rows: [ROW], rowCount: 1 })
  })
}

async function open(view: React.ReactElement, settled = true): Promise<HTMLElement> {
  stubFetch(!settled)
  const { container } = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  if (settled) await settle()
  return container
}

/** Every element `selector` finds in `scope` that does not carry `data-ui="<ui>"`. */
function unshared(scope: ParentNode, selector: string, ui: string): Element[] {
  return [...scope.querySelectorAll(selector)].filter((el) => el.getAttribute("data-ui") !== ui)
}

isolateEachTest()

const SCREENS: Array<[string, () => React.ReactElement]> = [
  ["Constraints", () => <ConstraintsView />],
  ["Indexes", () => <IndexesView />],
  ["Roles", () => <RolesView />],
]

describe.each(SCREENS)("Database > %s", (_name, view) => {
  it("shows the shared placeholder rows while it loads", async () => {
    const page = await open(view(), false)
    expect(page.querySelector('[data-ui="loading-rows"]')).toBeTruthy()
  })

  it("lists its rows in a shared table card of Th and Td cells", async () => {
    const page = await open(view())
    expect(page.querySelectorAll('[data-ui="table-card"] table')).toHaveLength(1)
    expect(page.querySelectorAll('th[data-ui="th"]').length).toBeGreaterThan(0)
    expect(unshared(page, "th", "th")).toEqual([])
    expect(unshared(page, "td", "td")).toEqual([])
    expect(unshared(page, "button", "button")).toEqual([])
  })
})

describe.each(SCREENS.slice(0, 2))("Database > %s schema picker", (_name, view) => {
  it("is the shared Select", async () => {
    const page = await open(view())
    expect(page.querySelectorAll('select[data-ui="select"][aria-label="Schema"]')).toHaveLength(1)
    expect(unshared(page, "select", "select")).toEqual([])
  })
})

describe("Database > Roles", () => {
  it("still links a SQL editor role to the SQL Runner", async () => {
    const page = await open(<RolesView />)
    expect(page.querySelector("a")?.textContent).toContain("Manage roles in SQL Runner")
  })
})

describe("Database > Extensions", () => {
  it("lists installed extensions in a shared table card, on shared controls", async () => {
    const page = await open(<ExtensionsView />)
    expect(page.querySelectorAll('[data-ui="table-card"] table')).toHaveLength(1)
    expect(unshared(page, "th", "th")).toEqual([])
    expect(unshared(page, "td", "td")).toEqual([])
    expect(unshared(page, "button", "button")).toEqual([])
    expect([...page.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Disable", "Enable"])
  })
})

describe("shared states", () => {
  it("draws the empty state's action as the shared Button", () => {
    const html = renderToStaticMarkup(<EmptyState title="None" action={() => {}} actionLabel="Refresh" />)
    expect(html).toMatch(/<button[^>]*data-ui="button"[^>]*>Refresh<\/button>/)
  })

  it("draws the error banner's Retry as the shared Button", () => {
    const html = renderToStaticMarkup(<ErrorBanner message="Refused" onRetry={() => {}} />)
    expect(html).toMatch(/<button[^>]*data-ui="button"[^>]*>Retry<\/button>/)
  })
})
