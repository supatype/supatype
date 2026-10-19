// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import { EditView } from "../src/views/EditView.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * Creating a self-host Todo: "Done" showed "No", but Save sent no `done`, and the required column
 * has no default, so the create failed with a not-null violation unless the toggle was switched on
 * and off. A boolean now starts at its column's default, else false, and is always sent.
 */

const TODO = testModel({
  name: "todo",
  tableName: "todo",
  fields: [
    testField({ name: "title", required: true }),
    testField({ name: "done", widget: "boolean", required: true }),
    testField({ name: "pinned", widget: "boolean" }),
  ],
})
const LOCALE = { currentLocale: "en", setLocale: () => {}, locales: [{ code: "en", label: "English" }], defaultLocale: "en" }

/** The introspection row for one `todo` column. */
function column(name: string, udt: string, columnDefault: string | null): Record<string, unknown> {
  return {
    table_name: "todo", table_schema: "public", column_name: name, udt_name: udt, is_nullable: "NO",
    column_default: columnDefault, is_primary: false, is_foreign_key: false, references_col: null, is_unique: false, row_count: 0,
  }
}
const COLUMNS = [column("title", "text", null), column("done", "bool", null), column("pinned", "bool", "true")]

let root: Root | null = null
let container: HTMLElement
let inserts: unknown[] = []

function stubFetch(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  inserts = []
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    const url = new URL(raw)
    if (url.pathname.endsWith("/metadata/introspect")) return Response.json({ rows: COLUMNS, rowCount: COLUMNS.length })
    if (url.pathname.endsWith("/rest/v1/todo") && init?.method === "POST") {
      inserts.push(JSON.parse(String(init.body)))
      return Response.json([{ id: "t1" }], { status: 201 })
    }
    return Response.json([])
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function createTodo(title: string): Promise<void> {
  stubFetch()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <AdminConfigContext.Provider value={testConfig({ models: [TODO] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <LocaleContext.Provider value={LOCALE}>
            <EditView model={TODO} onNavigate={() => {}} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    )
  })
  await settle()
  const input = container.querySelector<HTMLInputElement>("#field-title")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, title)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")
  await act(async () => save?.click())
  await settle()
}

describe("creating a record with boolean fields", () => {
  it("sends each boolean as shown: its column default, else false", async () => {
    await createTodo("mt15 todo")
    expect(inserts).toEqual([{ title: "mt15 todo", done: false, pinned: true }])
  })
})
