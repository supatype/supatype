// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { Badge, Th } from "../src/components/ui.js"
import { PoliciesView as AuthPoliciesView } from "../src/views/auth/PoliciesView.js"
import { StoragePoliciesView } from "../src/views/storage/PoliciesView.js"
import { metadataBody, testClient } from "./support.js"

/**
 * The policies views, as the owner found them on Authentication > Policies.
 *
 * Disable RLS switched a table's row security off on one click, with nothing between the click and
 * a table every role could read. A long expression pushed the whole page sideways, and the labels
 * beside it broke onto two lines.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const LONG_EXPRESSION = `(EXISTS ( SELECT 1 FROM rooms WHERE ((rooms.id = messages.room) AND (rooms.owner = auth.uid())))) AND ${"x".repeat(200)}`

type Catalogue = Record<string, Array<Record<string, unknown>>>

function catalogue(table: string, rlsEnabled: boolean): Catalogue {
  return {
    schemas: [{ schema_name: "auth" }],
    policies: [{ tablename: table, policyname: "owner_read", cmd: "SELECT", permissive: "PERMISSIVE", qual: LONG_EXPRESSION, with_check: null }],
    rls_status: [{ tablename: table, rls_enabled: rlsEnabled }],
  }
}

let root: Root | null = null
let container: HTMLElement
let writes: string[] = []

function stubFetch(rows: Catalogue): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = url.slice(PROXY.length)
    if (url.endsWith("/studio/auth/verify")) {
      return Response.json({ role: "developer", mode: "self", canElevate: false, permissions: { sqlEditor: true, schemaView: true } })
    }
    if (path.startsWith("/metadata")) {
      const found = rows[metadataBody(init).name ?? ""] ?? []
      return Response.json({ rows: found, rowCount: found.length })
    }
    writes.push(path)
    return Response.json({ ok: true })
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function render(view: React.ReactElement, rows: Catalogue): Promise<void> {
  stubFetch(rows)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={mockConfig}>
          <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

async function clickIn(scope: ParentNode, label: string): Promise<void> {
  const button = [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label)
  if (!button) throw new Error(`no button "${label}"`)
  await act(async () => { button.click() })
  await settle()
}

function question(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>("[role=alertdialog]")
}

beforeEach(() => { writes = [] })

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

const VIEWS: Array<[string, () => React.ReactElement, string]> = [
  ["Auth policies", () => <AuthPoliciesView />, "users"],
  ["Storage policies", () => <StoragePoliciesView />, "objects"],
]

describe.each(VIEWS)("%s", (_label, view, table) => {
  it("asks before disabling RLS, and says what that means", async () => {
    await render(view(), catalogue(table, true))
    await clickIn(container, "Disable RLS")
    expect(writes).toEqual([])
    const asking = question()
    expect(asking?.textContent).toContain("every row")
    await clickIn(asking!, "Disable RLS")
    expect(writes).toEqual(["/studio-admin/rls"])
  })

  it("leaves RLS on when the question is cancelled", async () => {
    await render(view(), catalogue(table, true))
    await clickIn(container, "Disable RLS")
    await clickIn(question()!, "Cancel")
    expect(question()).toBeNull()
    expect(writes).toEqual([])
  })

  it("enables RLS without asking, since that only narrows access", async () => {
    await render(view(), catalogue(table, false))
    await clickIn(container, "Enable RLS")
    expect(question()).toBeNull()
    expect(writes).toEqual(["/studio-admin/rls"])
  })

  it("wraps a long expression inside its cell instead of widening the page", async () => {
    await render(view(), catalogue(table, true))
    const code = [...container.querySelectorAll("code")].find((c) => c.textContent === LONG_EXPRESSION)
    expect(code?.className).toContain("whitespace-pre-wrap")
    expect(code?.className).toContain("break-all")
    expect(container.querySelector("table")?.className).toContain("table-fixed")
  })
})

describe("labels stay on one line", () => {
  it("never wraps a badge or a column heading", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<table><thead><tr><Th>Applies to</Th></tr></thead><tbody><tr><td><Badge>WITH CHECK</Badge></td></tr></tbody></table>)
    })
    expect(container.querySelector("th")?.className).toContain("whitespace-nowrap")
    expect(container.querySelector("span")?.className).toContain("whitespace-nowrap")
  })
})
