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
import { isShape, isString, optional } from "../src/lib/json.js"
import { asking, press } from "./dialog-support.js"
import { act, isolateEachTest, mount, settle, testClient } from "./support.js"

/**
 * The Database screens for tables, functions, triggers, views and types are built from the shared
 * primitives: the schema picker is the shared Select, each list is a shared table card of Th and Td
 * cells, every control is the shared Button, and every question is the shared Dialog. A screen
 * drawn from raw elements carries its own type scale and spacing and drifts from the rest of Studio.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })

/** One row every view can render. */
const ROW = {
  table_name: "orders", row_estimate: 3, bytes: 2048, routine_name: "do_it", return_type: "void", language: "PLPGSQL",
  trigger_name: "audit", event_object_table: "orders", event_manipulation: "INSERT", action_timing: "BEFORE",
  action_orientation: "ROW", action_statement: "EXECUTE FUNCTION do_it()", view_name: "active",
  view_definition: "SELECT 1", typname: "mood", typtype: "e", enum_values: ["a", "b"],
}

const isSqlBody = isShape({ query: isString, schema: optional(isString) })

let sent: string[] = []

function stubFetch(sqlEditor: boolean): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/studio/auth/verify")) {
      const role = sqlEditor ? "developer" : "viewer"
      return Response.json({ role, mode: "self", canElevate: false, permissions: { sqlEditor, schemaView: true } })
    }
    if (url.endsWith("/sql")) {
      const body: unknown = JSON.parse(String(init?.body))
      if (isSqlBody(body)) sent.push(body.query)
      return Response.json({ rows: [], rowCount: 0 })
    }
    return Response.json({ rows: [ROW], rowCount: 1 })
  })
}

async function open(view: React.ReactElement, sqlEditor = true): Promise<HTMLElement> {
  stubFetch(sqlEditor)
  const { container } = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={CLIENT}>{view}</AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return container
}

/** The text of every button in `scope`, in page order. */
function labels(scope: ParentNode): string[] {
  return [...scope.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim())
}

/** Every element `selector` finds in `scope` that does not carry `data-ui="<ui>"`. */
function unshared(scope: ParentNode, selector: string, ui: string): Element[] {
  return [...scope.querySelectorAll(selector)].filter((el) => el.getAttribute("data-ui") !== ui)
}

/** Answers the open question with its destructive act. */
async function answer(): Promise<void> {
  const buttons = [...document.body.querySelectorAll('[role="alertdialog"] button')]
  const act_ = buttons.at(-1)
  if (!(act_ instanceof HTMLButtonElement)) throw new Error("nothing is being asked")
  await act(() => { act_.click() })
  await settle()
}

/** Replaces the open draft's text, the way React hears typing. */
async function edit(sql: string): Promise<void> {
  const box = document.body.querySelector("textarea")
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  if (!box || !setter) throw new Error("no SQL draft is open")
  await act(() => { setter.call(box, sql); box.dispatchEvent(new Event("input", { bubbles: true })) })
}

beforeEach(() => { sent = [] })
isolateEachTest()

/** A screen, the button that opens its create flow, and what a writer and a reader are offered. */
type Screen = [string, () => React.ReactElement, string, string[], string[]]

const SCREENS: Screen[] = [
  ["Tables", () => <TablesView />, "Create table", ["Create table", "Browse data", "Drop"], ["Browse data"]],
  ["Functions", () => <FunctionsView />, "Create function", ["Create function", "Drop"], []],
  ["Triggers", () => <TriggersView />, "Create trigger", ["Create trigger", "Drop"], []],
  ["Views", () => <ViewsView />, "Create view", ["Create view", "Edit", "Drop"], []],
  ["Types", () => <TypesView />, "Create enum", ["Create enum", "Drop"], []],
]

describe.each(SCREENS)("Database > %s", (_name, view, create, writer, reader) => {
  it("picks the schema with the shared Select", async () => {
    const page = await open(view())
    expect(page.querySelectorAll('select[data-ui="select"][aria-label="Schema"]')).toHaveLength(1)
    expect(unshared(page, "select", "select")).toEqual([])
  })

  it("lists its rows in a shared table card of Th and Td cells", async () => {
    const page = await open(view())
    expect(page.querySelectorAll('[data-ui="table-card"] table')).toHaveLength(1)
    expect(page.querySelectorAll('th[data-ui="th"]').length).toBeGreaterThan(0)
    expect(unshared(page, "th", "th")).toEqual([])
    expect(unshared(page, "td", "td")).toEqual([])
  })

  it("draws every control as the shared Button", async () => {
    const page = await open(view())
    expect(page.querySelectorAll('button[data-ui="button"]').length).toBeGreaterThan(0)
    expect(unshared(page, "button", "button")).toEqual([])
  })

  it("offers a writer its actions, in order", async () => {
    expect(labels(await open(view()))).toEqual(writer)
  })

  it("offers a reader only what reads", async () => {
    expect(labels(await open(view(), false))).toEqual(reader)
  })

  it("opens its create flow on shared controls", async () => {
    const page = await open(view())
    await press(create)
    expect(unshared(page, "button", "button")).toEqual([])
    expect(unshared(page, "textarea", "textarea")).toEqual([])
    expect(unshared(page, "input", "input")).toEqual([])
  })
})

/** The screens whose create and drop flows draft SQL for review in a dialog. */
const DRAFTING: Array<[string, () => React.ReactElement, string]> = [
  ["Tables", () => <TablesView />, "Create table"],
  ["Functions", () => <FunctionsView />, "Create function"],
  ["Triggers", () => <TriggersView />, "Create trigger"],
  ["Views", () => <ViewsView />, "Create view"],
]

describe.each(DRAFTING)("Database > %s SQL draft", (_name, view, create) => {
  it("is the shared Dialog holding the shared Textarea", async () => {
    const page = await open(view())
    await press(create)
    const dialog = page.querySelector('[data-ui="dialog"][role="dialog"]')
    expect(dialog?.querySelector('textarea[data-ui="textarea"]')).toBeTruthy()
  })

  it("asks before running a drop, and runs it on the answer", async () => {
    await open(view())
    await press("Drop")
    await press("Run SQL")
    expect(asking()).toContain("Run this SQL on")
    expect(sent).toEqual([])
    await answer()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^DROP /)
  })

  it("runs a create straight after review, without a second question", async () => {
    await open(view())
    await press(create)
    await press("Run SQL")
    expect(asking()).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^CREATE /)
  })

  it("judges the draft by what it says when Run is pressed", async () => {
    await open(view())
    await press(create)
    await edit("DROP TABLE x;")
    await press("Run SQL")
    expect(asking()).toContain("Run this SQL on")
    expect(sent).toEqual([])
  })

  it("closes on Cancel and runs nothing", async () => {
    const page = await open(view())
    await press("Drop")
    await press("Cancel")
    expect(page.querySelector('[data-ui="dialog"]')).toBeNull()
    expect(sent).toEqual([])
  })
})

describe("Database > draft titles and the drop look", () => {
  it.each([
    [() => <TablesView />, "Drop", "Drop table orders", "destructive"],
    [() => <TablesView />, "Create table", "Create table", "primary"],
    [() => <ViewsView />, "Drop", "Drop view active", "destructive"],
    [() => <ViewsView />, "Edit", "Create / replace view", "primary"],
    [() => <FunctionsView />, "Drop", "SQL", "destructive"],
    [() => <TriggersView />, "Drop", "SQL", "destructive"],
    [() => <FunctionsView />, "Create function", "SQL", "primary"],
  ])("%#: names the draft, and colours Run red only when it destroys", async (view, opener, title, variant) => {
    const page = await open(view())
    await press(opener)
    const dialog = page.querySelector('[data-ui="dialog"]')
    expect(dialog?.querySelector("h2")?.textContent).toBe(title)
    const run = [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Run SQL")
    expect(run?.className).toContain(variant === "destructive" ? "bg-destructive" : "bg-primary")
  })
})

describe("Database > Types", () => {
  it("asks before dropping, in the shared Dialog as an alertdialog", async () => {
    const page = await open(<TypesView />)
    await press("Drop")
    const dialog = page.querySelector('[data-ui="dialog"][role="alertdialog"]')
    expect(dialog?.textContent).toContain("Drop type mood?")
    expect(sent).toEqual([])
    await press("Cancel")
    expect(page.querySelector('[data-ui="dialog"]')).toBeNull()
    expect(sent).toEqual([])
  })

  it("builds the new enum form from the shared Input", async () => {
    const page = await open(<TypesView />)
    await press("Create enum")
    expect(page.querySelectorAll('input[data-ui="input"]')).toHaveLength(2)
    expect(labels(page)).toContain("Create")
  })
})
