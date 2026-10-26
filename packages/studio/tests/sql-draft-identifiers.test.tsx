// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { FunctionsView } from "../src/views/database/FunctionsView.js"
import { TablesView } from "../src/views/database/TablesView.js"
import { TriggersView } from "../src/views/database/TriggersView.js"
import { TypesView } from "../src/views/database/TypesView.js"
import { ViewsView } from "../src/views/database/ViewsView.js"
import { PoliciesView } from "../src/views/auth/PoliciesView.js"
import { isShape, isString, optional } from "../src/lib/json.js"
import { act, isolateEachTest, metadataBody, mount, settle, testClient } from "./support.js"
import { press } from "./dialog-support.js"

/**
 * Every statement Studio drafts or runs from a schema, table, policy, function, trigger, view or
 * type name quotes that name as the catalogue spelled it. A bare `MyApp` folds to `myapp` and
 * misses the schema; a name holding `"` ends the identifier early; and a schema outside a narrow
 * pattern was once swapped for `public` without a word.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

/** One row every view can render, each name carrying a capital, a space or a quote. */
const ROW = {
  table_name: 'Order"Items', tablename: 'Order"Items', routine_name: 'Do"It', routine_type: "FUNCTION",
  trigger_name: 'Audit"Log', event_object_table: 'Order"Items', event_manipulation: "INSERT",
  view_name: 'Active"Users', view_definition: "SELECT 1", typname: 'My"Mood', typtype: "e", enum_values: ["a"],
  policyname: 'Owner"Read', cmd: "SELECT", permissive: "PERMISSIVE", roles: "{public}", qual: "true",
  with_check: null, rls_enabled: false, row_estimate: 0, bytes: 0,
}

/** Each schema, with the identifier Postgres has to see for it. */
const SCHEMAS: Array<[string, string]> = [["MyApp", '"MyApp"'], ['My"App', '"My""App"'], ["public", '"public"']]

const isSqlBody = isShape({ query: isString, schema: optional(isString) })

let sent: Array<{ query: string; schema: string | undefined }> = []
let lookedUp: unknown[] = []

function stubFetch(schema: string): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/studio/auth/verify")) {
      return Response.json({ role: "developer", mode: "self", canElevate: false, permissions: { sqlEditor: true, schemaView: true } })
    }
    if (url.endsWith("/sql")) {
      const body: unknown = JSON.parse(String(init?.body))
      if (!isSqlBody(body)) throw new Error(`not a SQL request: ${String(init?.body)}`)
      sent.push({ query: body.query, schema: body.schema })
      return Response.json({ rows: [], rowCount: 0 })
    }
    const meta = metadataBody(init)
    if (meta.name === "schemas") return Response.json({ rows: [{ schema_name: schema }], rowCount: 1 })
    if (meta.name === "policies") lookedUp.push(meta.params?.["schema"])
    return Response.json({ rows: [ROW], rowCount: 1 })
  })
}

async function open(view: React.ReactElement, schema: string): Promise<void> {
  stubFetch(schema)
  await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
}

/** The statement drafted for review, as the textarea holds it. */
function draft(): string {
  const box = document.body.querySelector("textarea")
  if (!box) throw new Error("no SQL draft is open")
  return box.value
}

/** Types `value` into the input whose placeholder is `placeholder`, the way React hears it. */
async function typeInto(placeholder: string, value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  if (!input || !setter) throw new Error(`no input "${placeholder}"`)
  await act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })) })
}

beforeEach(() => { sent = []; lookedUp = [] })
isolateEachTest()

/** A view, the buttons pressed in order, and the statement those presses draft for schema `s`. */
type DraftCase = [string, () => React.ReactElement, string[], (s: string) => string]

const DRAFTS: DraftCase[] = [
  ["drops a policy", () => <PoliciesView />, ["Drop"], (s) => `DROP POLICY "Owner""Read" ON ${s}."Order""Items";`],
  ["creates a policy", () => <PoliciesView />, ["Create policy", "I understand, continue"], (s) => `CREATE POLICY my_policy ON ${s}.my_table`],
  ["creates a table", () => <TablesView />, ["Create table"], (s) => `CREATE TABLE ${s}.new_table (`],
  ["drops a table", () => <TablesView />, ["Drop"], (s) => `DROP TABLE ${s}."Order""Items";`],
  ["creates a function", () => <FunctionsView />, ["Create function"], (s) => `CREATE OR REPLACE FUNCTION ${s}.my_function()`],
  ["drops a function", () => <FunctionsView />, ["Drop"], (s) => `DROP FUNCTION ${s}."Do""It"();`],
  ["creates a trigger", () => <TriggersView />, ["Create trigger"], (s) => `BEFORE INSERT ON ${s}.my_table`],
  ["drops a trigger", () => <TriggersView />, ["Drop"], (s) => `DROP TRIGGER "Audit""Log" ON ${s}."Order""Items";`],
  ["creates a view", () => <ViewsView />, ["Create view"], (s) => `CREATE VIEW ${s}.new_view AS`],
  ["edits a view", () => <ViewsView />, ["Edit"], (s) => `CREATE OR REPLACE VIEW ${s}."Active""Users" AS\nSELECT 1`],
  ["drops a view", () => <ViewsView />, ["Drop"], (s) => `DROP VIEW ${s}."Active""Users";`],
]

describe.each(SCHEMAS)("in schema %s", (schema, quoted) => {
  it.each(DRAFTS)("%s with every name quoted", async (_label, view, presses, expected) => {
    await open(view(), schema)
    for (const label of presses) await press(label)
    expect(draft()).toContain(expected(quoted))
  })

  it("lists the schema's policies by its exact name", async () => {
    await open(<PoliciesView />, schema)
    // Before the schema list arrives the picker reads `public`; once it has, the exact name.
    expect(lookedUp.at(-1)).toBe(schema)
    expect(document.body.textContent).toContain('Owner"Read')
  })

  it("enables RLS on the exact schema and table", async () => {
    await open(<PoliciesView />, schema)
    await press("Enable RLS")
    expect(sent).toEqual([{ query: `ALTER TABLE ${quoted}."Order""Items" ENABLE ROW LEVEL SECURITY;`, schema }])
  })

  it("creates an enum with its schema and name quoted", async () => {
    await open(<TypesView />, schema)
    await press("Create enum")
    await typeInto("my_status", 'Mood"X')
    await typeInto("draft, published, archived", "a, b")
    await press("Create")
    expect(sent).toEqual([{ query: `CREATE TYPE ${quoted}."Mood""X" AS ENUM ('a', 'b');`, schema }])
  })

  it("drops an enum with its schema and name quoted", async () => {
    await open(<TypesView />, schema)
    await press("Drop")
    const buttons = [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Drop")
    await act(() => { buttons.at(-1)?.click() })
    await settle()
    expect(sent).toEqual([{ query: `DROP TYPE ${quoted}."My""Mood";`, schema }])
  })
})
