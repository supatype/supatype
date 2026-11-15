// @vitest-environment jsdom
import { EditorView } from "@codemirror/view"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { sqlErrorHint } from "../src/lib/sql-error-hint.js"
import { SqlRunner } from "../src/views/SqlRunner.js"
import { act, button, isolateEachTest, mount, settle, testClient } from "./support.js"

/**
 * The image loads pg_safeupdate for every session, the SQL editor's included, so `DELETE FROM t`
 * fails with "DELETE requires a WHERE clause". The error alone reads like a Studio bug; the runner
 * says what refused it and how to mean every row (finding #27).
 */

isolateEachTest()

async function runnerAnswering(error: string): Promise<{ view: EditorView; container: HTMLElement }> {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() })
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/studio/auth/verify")) return Response.json({ role: "admin", mode: "self", permissions: { sqlEditor: true } })
    return Response.json({ error, code: "21000" }, { status: 400 })
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
  return { view, container }
}

async function runConfirmed(view: EditorView, container: HTMLElement, sql: string): Promise<void> {
  await act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql } }) })
  await act(() => { button(container, "Run Query").click() })
  await settle()
  const dialog = document.body.querySelector<HTMLElement>("[role=alertdialog]")
  if (dialog !== null) {
    await act(() => { button(dialog, "Run SQL").click() })
    await settle()
  }
}

describe("a DELETE or UPDATE with no WHERE", () => {
  it("shows the error and a hint naming pg_safeupdate and WHERE true", async () => {
    const { view, container } = await runnerAnswering("DELETE requires a WHERE clause")
    await runConfirmed(view, container, "DELETE FROM posts;")
    expect(container.textContent).toContain("DELETE requires a WHERE clause")
    expect(container.textContent).toContain("pg_safeupdate")
    expect(container.textContent).toContain("WHERE true")
  })

  it("adds no hint to any other error", async () => {
    const { view, container } = await runnerAnswering('relation "nope" does not exist')
    await runConfirmed(view, container, "SELECT * FROM nope;")
    expect(container.textContent).toContain('relation "nope" does not exist')
    expect(container.textContent).not.toContain("pg_safeupdate")
  })
})

describe("sqlErrorHint", () => {
  it("answers both statements the extension refuses, and nothing else", () => {
    expect(sqlErrorHint("DELETE requires a WHERE clause")).toContain("WHERE true")
    expect(sqlErrorHint("UPDATE requires a WHERE clause")).toContain("WHERE true")
    expect(sqlErrorHint("syntax error at or near \"WHER\"")).toBeNull()
  })
})
