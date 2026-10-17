// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { ExtensionsView } from "../src/views/database/ExtensionsView.js"
import { FunctionsView } from "../src/views/database/FunctionsView.js"
import { TablesView } from "../src/views/database/TablesView.js"
import { TriggersView } from "../src/views/database/TriggersView.js"
import { TypesView } from "../src/views/database/TypesView.js"
import { ViewsView } from "../src/views/database/ViewsView.js"
import { PoliciesView as AuthPoliciesView } from "../src/views/auth/PoliciesView.js"
import { StoragePoliciesView } from "../src/views/storage/PoliciesView.js"
import { testClient } from "./support.js"

/**
 * RQ4: every write Studio makes through the SQL editor's route (create or drop a table, view,
 * function, trigger, type or policy; enable an extension; switch RLS) is offered only to the roles
 * that hold the SQL editor, as the editor itself is. A viewer reads the schema and is offered
 * nothing that the server would refuse.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

/** One row every view can render, whatever it asks for. */
const ROW = {
  schema_name: "public", table_name: "t", row_estimate: 0, bytes: 0, extname: "pgcrypto", extversion: "1",
  name: "hstore", default_version: "1", routine_name: "f", routine_type: "FUNCTION", trigger_name: "tr",
  event_object_table: "t", event_manipulation: "INSERT", typname: "e", typtype: "e", enum_values: ["a"],
  view_name: "v", view_definition: "SELECT 1", tablename: "t", policyname: "p", cmd: "SELECT", roles: "{public}",
  qual: "true", with_check: null, relname: "t", rowsecurity: true, relrowsecurity: true, schemaname: "public",
}

const WRITES = /^(Create (table|function|trigger|enum|view|policy)|Drop|Edit|Enable|Disable|Enable RLS|Disable RLS)$/

let root: Root | null = null
let container: HTMLElement

function stubFetch(role: string, sqlEditor: boolean): void {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/studio/auth/verify")) {
      return Response.json({ role, mode: "self", canElevate: false, permissions: { sqlEditor, schemaView: true } })
    }
    return Response.json({ rows: [ROW], rowCount: 1 })
  })
}

async function render(view: React.ReactElement, role: string, sqlEditor: boolean): Promise<string[]> {
  stubFetch(role, sqlEditor)
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
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter((t) => WRITES.test(t))
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

const VIEWS: Array<[string, () => React.ReactElement, string]> = [
  ["Extensions", () => <ExtensionsView />, "Enable"],
  ["Functions", () => <FunctionsView />, "Create function"],
  ["Tables", () => <TablesView />, "Create table"],
  ["Triggers", () => <TriggersView />, "Create trigger"],
  ["Types", () => <TypesView />, "Create enum"],
  ["Views", () => <ViewsView />, "Create view"],
  ["Auth policies", () => <AuthPoliciesView />, "Create policy"],
  ["Storage policies", () => <StoragePoliciesView />, "Create policy"],
]

describe("SQL writes in Studio's views", () => {
  it.each(VIEWS)("%s offers a viewer no write", async (_label, view) => {
    expect(await render(view(), "viewer", false)).toEqual([])
  })

  it.each(VIEWS)("%s offers a developer its writes", async (_label, view, write) => {
    expect(await render(view(), "developer", true)).toContain(write)
  })
})
