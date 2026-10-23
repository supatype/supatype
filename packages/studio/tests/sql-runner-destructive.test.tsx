// @vitest-environment jsdom
import { EditorView, runScopeHandlers } from "@codemirror/view"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { destructiveStatements, isDestructiveSql } from "../src/lib/sql-destructive.js"
import { SqlRunner } from "../src/views/SqlRunner.js"
import { asking } from "./dialog-support.js"
import { act, button, isolateEachTest, mount, settle, testClient } from "./support.js"

/**
 * The SQL editor runs what is typed. Owner rule: SQL that drops, empties or overwrites something
 * asks a second question first, in Studio's own dialog, and Cancel runs nothing; anything else runs
 * on the click or on Ctrl/Cmd+Enter as it always did. The editor runs its whole text (there is no
 * run-selection), so the whole text is what is judged.
 */

isolateEachTest()

/** The SQL the runner sent to the server, in order. */
async function runner(): Promise<{ view: EditorView; container: HTMLElement; sent: string[] }> {
  // jsdom lays nothing out, and CodeMirror measures the selection with these once the page renders.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() })
  const sent: string[] = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/studio/auth/verify")) return Response.json({ role: "admin", mode: "self", permissions: { sqlEditor: true } })
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null
    if (typeof body === "object" && body !== null && "query" in body && typeof body.query === "string") sent.push(body.query)
    return Response.json({ rows: [{ one: 1 }], rowCount: 1 })
  })
  const client = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
  const { container } = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={client}><SqlRunner /></AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  const dom = container.querySelector<HTMLElement>(".cm-editor")
  const view = dom === null ? null : EditorView.findFromDOM(dom)
  if (view === null) throw new Error("no SQL editor")
  return { view, container, sent }
}

async function write(view: EditorView, sql: string): Promise<void> {
  await act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql } }) })
}

async function runFromButton(container: HTMLElement): Promise<void> {
  await act(() => { button(container, "Run Query").click() })
  await settle()
}

/** Ctrl+Enter in the editor, through its keymap (jsdom is not a Mac, so Mod is Ctrl). */
async function runFromKeyboard(view: EditorView): Promise<void> {
  const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: true, bubbles: true, cancelable: true })
  await act(() => { runScopeHandlers(view, event, "editor") })
  await settle()
}

describe("running SQL in the editor", () => {
  it("runs a SELECT straight away", async () => {
    const { view, container, sent } = await runner()
    await write(view, "SELECT 1;")
    await runFromButton(container)
    expect(asking()).toBeNull()
    expect(sent).toEqual(["SELECT 1;"])
  })

  it("asks before a DROP, naming it, and Cancel runs nothing", async () => {
    const { view, container, sent } = await runner()
    await write(view, "DROP TABLE posts;")
    await runFromButton(container)
    expect(asking()).toContain("Run this SQL on")
    expect(asking()).toContain("DROP TABLE posts")
    await act(() => { button(document.body.querySelector("[role=alertdialog]") ?? document.body, "Cancel").click() })
    await settle()
    expect(asking()).toBeNull()
    expect(sent).toEqual([])
  })

  it("runs a DROP once the question is answered", async () => {
    const { view, container, sent } = await runner()
    await write(view, "SELECT 1; DROP TABLE posts;")
    await runFromButton(container)
    await act(() => { button(document.body.querySelector("[role=alertdialog]") ?? document.body, "Run SQL").click() })
    await settle()
    expect(sent).toEqual(["SELECT 1; DROP TABLE posts;"])
  })

  it("asks before a DELETE run with Ctrl/Cmd+Enter too", async () => {
    const { view, sent } = await runner()
    await write(view, "DELETE FROM posts;")
    await runFromKeyboard(view)
    expect(asking()).toContain("DELETE FROM posts")
    expect(sent).toEqual([])
  })

  it("runs a SELECT from Ctrl/Cmd+Enter straight away", async () => {
    const { view, sent } = await runner()
    await write(view, "SELECT 2;")
    await runFromKeyboard(view)
    expect(asking()).toBeNull()
    expect(sent).toEqual(["SELECT 2;"])
  })
})

describe("naming what a run destroys", () => {
  it("lists each destructive statement as written, and nothing else", () => {
    expect(destructiveStatements(`SELECT ';'; DROP TABLE "a;b"; -- DROP nothing\nUPDATE t SET x = 1`)).toEqual([`DROP TABLE "a;b"`, "-- DROP nothing\nUPDATE t SET x = 1"])
  })

  // A quoted name was blanked to one space, so `UPDATE "posts" SET` read as `UPDATE   SET`, which
  // the data-modifying WITH check did not recognise, and the statement ran without a question.
  it("finds an update of a quoted table inside a WITH", () => {
    expect(isDestructiveSql(`WITH a AS (SELECT 1) UPDATE "posts" SET title = 'x'`)).toBe(true)
  })
})
