// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import type { SupatypeClient } from "@supatype/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { RolesView } from "../src/views/database/RolesView.js"
import { TablesView } from "../src/views/database/TablesView.js"
import { ExtensionsView } from "../src/views/database/ExtensionsView.js"
import { IndexesView } from "../src/views/database/IndexesView.js"
import { ConstraintsView } from "../src/views/database/ConstraintsView.js"
import { FunctionsView } from "../src/views/database/FunctionsView.js"
import { TriggersView } from "../src/views/database/TriggersView.js"
import { TypesView } from "../src/views/database/TypesView.js"
import { ViewsView } from "../src/views/database/ViewsView.js"

/**
 * RQ3: Studio's Database views read schema metadata through the read-only metadata route, by name
 * with bound parameters, so a viewer (schema view, no SQL editor) can use them. None of them sends
 * SQL of its own to read.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = { url: PROXY, auth: { currentAccessToken: "token" } } as unknown as SupatypeClient

let root: Root | null = null
let container: HTMLElement
type MetadataBody = { name?: string; params?: Record<string, unknown> }
let calls: Array<{ url: string; body: MetadataBody }> = []

/** The request's JSON body, checked to be an object before it is read as one. */
function bodyOf(init?: RequestInit): MetadataBody {
  const parsed: unknown = init?.body ? JSON.parse(String(init.body)) : {}
  return typeof parsed === "object" && parsed !== null ? (parsed as MetadataBody) : {}
}

function stubFetch(): void {
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = bodyOf(init)
    calls.push({ url, body })
    const name = body.name
    const rows = name === "schemas" ? [{ schema_name: "public" }] : []
    return Response.json({ rows, rowCount: rows.length })
  })
}

async function render(view: React.ReactElement): Promise<void> {
  stubFetch()
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

const VIEWS: Array<[string, () => React.ReactElement, string[]]> = [
  ["Roles", () => <RolesView />, ["roles"]],
  ["Tables", () => <TablesView />, ["schemas", "tables"]],
  ["Extensions", () => <ExtensionsView />, ["extensions_installed", "extensions_available"]],
  ["Indexes", () => <IndexesView />, ["schemas", "indexes"]],
  ["Constraints", () => <ConstraintsView />, ["schemas", "constraints"]],
  ["Functions", () => <FunctionsView />, ["schemas", "functions"]],
  ["Triggers", () => <TriggersView />, ["schemas", "triggers"]],
  ["Types", () => <TypesView />, ["schemas", "types"]],
  ["Views", () => <ViewsView />, ["schemas", "views"]],
]

describe("the Database views", () => {
  it.each(VIEWS)("%s reads through the metadata route, by name", async (_label, view, names) => {
    await render(view())
    expect(calls.filter((c) => c.url.endsWith("/sql"))).toEqual([])
    const asked = calls.filter((c) => c.url === `${PROXY}/metadata`).map((c) => c.body.name)
    for (const name of names) expect(asked).toContain(name)
  })

  it("passes the schema as a bound parameter, never inside SQL", async () => {
    await render(<TablesView />)
    const tables = calls.find((c) => c.body.name === "tables")
    expect(tables?.body.params).toEqual({ schema: "public" })
  })
})
