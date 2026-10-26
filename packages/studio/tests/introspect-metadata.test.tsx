// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { DataExplorer } from "../src/views/DataExplorer.js"
import { ModelSchema } from "../src/views/ModelSchema.js"
import { SchemaView } from "../src/views/SchemaView.js"
import { metadataBody, testClient, type MetadataBody } from "./support.js"

/**
 * The screens that list a schema's tables and columns read them through the metadata route's
 * `introspect` query, which every role that may read rows can use. They used to send their own SQL
 * to the SQL editor's route, which only owners, admins and developers may use (RX1), so an editor's
 * Data Explorer and a viewer's schema screens came up empty. The stub answers `/sql` the way both
 * hosts answer an editor or a viewer there: refused.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

type Call = { url: string; body: MetadataBody }

const COLUMNS = [
  { table_name: "posts", table_schema: "public", column_name: "id", udt_name: "uuid", is_nullable: "NO", column_default: null, is_primary: true, is_foreign_key: false, references_col: null, is_unique: false, row_count: 3 },
  { table_name: "posts", table_schema: "public", column_name: "title", udt_name: "text", is_nullable: "YES", column_default: null, is_primary: false, is_foreign_key: false, references_col: null, is_unique: false, row_count: 3 },
]

let root: Root | null = null
let container: HTMLElement
let calls: Call[] = []

/** jsdom has no ResizeObserver, which the Schema view's diagram needs to mount. */
class NoResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function stubFetch(): void {
  vi.stubGlobal("ResizeObserver", NoResizeObserver)
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = metadataBody(init)
    calls.push({ url, body })
    if (url.endsWith("/sql")) return Response.json({ error: "forbidden", message: "Your role cannot use the SQL editor" }, { status: 403 })
    if (url.endsWith("/metadata/introspect")) return Response.json({ rows: COLUMNS, rowCount: COLUMNS.length })
    // A row read through the REST API, which PostgREST answers with an array.
    if (url.includes("/rest/v1/")) return Response.json([])
    const rows = body.name === "schemas" ? [{ schema_name: "public" }] : []
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
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

const model = mockConfig.models.find((m) => m.tableName === "posts")!

describe.each([
  ["Data Explorer", () => <DataExplorer />],
  ["a model's Schema tab", () => <ModelSchema model={model} />],
  ["the Schema view", () => <SchemaView />],
] as Array<[string, () => React.ReactElement]>)("%s, for an editor or a viewer", (_label, view) => {
  it("lists the tables through the metadata route, never the SQL editor's", async () => {
    await render(view())
    expect(calls.filter((c) => c.url.endsWith("/sql"))).toEqual([])
    const introspect = calls.find((c) => c.url === `${PROXY}/metadata/introspect`)
    expect(introspect?.body).toEqual({ name: "introspect", params: { schema: "public" } })
    expect(container.textContent).not.toContain("Your role cannot use the SQL editor")
    expect(container.textContent).toContain("title")
  })
})
