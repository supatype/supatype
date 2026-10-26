// @vitest-environment jsdom
import { autocompletion, completionStatus, startCompletion } from "@codemirror/autocomplete"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { runAndCloseCompletion, SqlRunner } from "../src/views/SqlRunner.js"
import { testClient } from "./support.js"

/**
 * Fresh-test cosmetic: running a query with Mod-Enter left the autocomplete list open over the
 * editor. Running now closes it first. The Run Query button left it open too (fresh-test local21
 * C12), so the button closes it the same way.
 */

async function waitForCompletion(view: EditorView): Promise<void> {
  for (let i = 0; i < 20 && completionStatus(view.state) !== "active"; i++) await new Promise((r) => setTimeout(r, 20))
}

async function viewWithOpenCompletion(): Promise<EditorView> {
  const view = new EditorView({
    state: EditorState.create({
      doc: "sel",
      selection: { anchor: 3 },
      extensions: [autocompletion({ override: [() => ({ from: 0, options: [{ label: "select" }] })] })],
    }),
    parent: document.body,
  })
  startCompletion(view)
  await waitForCompletion(view)
  return view
}

describe("running from the SQL editor", () => {
  it("closes the autocomplete list and runs", async () => {
    const view = await viewWithOpenCompletion()
    expect(completionStatus(view.state)).toBe("active")
    let ran = 0
    expect(runAndCloseCompletion(view, () => { ran++ })).toBe(true)
    expect(ran).toBe(1)
    expect(completionStatus(view.state)).toBeNull()
    view.destroy()
  })
})

let root: Root | null = null
let container: HTMLElement

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

/** The SQL editor page for a role that holds it, every query answering one row. */
async function renderRunner(): Promise<EditorView> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // jsdom lays nothing out, and CodeMirror measures the selection with these once the page renders.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() })
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/studio/auth/verify")) return Response.json({ role: "admin", mode: "self", permissions: { sqlEditor: true } })
    return Response.json({ rows: [{ one: 1 }], rowCount: 1 })
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const client = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={mockConfig}>
          <AdminClientContext.Provider value={client}><SqlRunner /></AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const dom = container.querySelector<HTMLElement>(".cm-editor")
  const view = dom === null ? null : EditorView.findFromDOM(dom)
  if (view === null) throw new Error("no SQL editor")
  return view
}

describe("the Run Query button", () => {
  it("closes the autocomplete list too", async () => {
    const view = await renderRunner()
    act(() => { startCompletion(view) })
    await act(async () => { await waitForCompletion(view) })
    expect(completionStatus(view.state)).toBe("active")
    const run = [...container.querySelectorAll("button")].find((b) => b.textContent === "Run Query")
    await act(async () => { run?.click() })
    expect(completionStatus(view.state)).toBeNull()
  })
})
