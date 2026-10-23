// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelConfig } from "../src/config.js"
import { EditView } from "../src/views/EditView.js"
import { ListView } from "../src/views/ListView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * A viewer reads content. Globals and the Data browser already gave them read-only inputs and no
 * Save, but a model record (fresh-test local21 C2: post, author) still offered an enabled Save that
 * the server refused. The record editor and the list now follow the same rule.
 */

const LOCALE: LocaleState = { currentLocale: "en", defaultLocale: "en", locales: [{ code: "en", label: "English" }], setLocale: () => {} }
const fields = [testField({ name: "id", widget: "uuid", readOnly: true }), testField({ name: "name", label: "Name" })]
const AUTHOR = testModel({ name: "author", label: "Author", labelPlural: "Authors", tableName: "author", fields, listColumns: ["name"] })
const POST = testModel({ name: "post", label: "Post", labelPlural: "Posts", tableName: "post", fields, listColumns: ["name"], versions: { drafts: true, keep: 20, versionsTable: "post_versions", localizedColumns: [] } })
const ROW = { id: "a1", name: "Ada" }
const WRITE_LABELS = ["Save", "Save draft", "Publish", "Duplicate", "Delete", "Create Author"]

let container: HTMLDivElement
let root: Root

const REFUSED = 'Studio role "editor" cannot perform this request'

function serve(role: string): void {
  const permissions = { read: true, write: role !== "viewer" }
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (init?.method === "PATCH" || init?.method === "POST") return Response.json({ error: REFUSED }, { status: 403 })
    if (input.includes("/studio/session")) return Response.json({ mode: "studio", fields: {}, access: {} })
    if (input.includes("/studio/auth/verify")) return Response.json({ role, seesDrafts: true, permissions })
    return Response.json([ROW])
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function render(role: string, view: React.ReactElement): Promise<void> {
  serve(role)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={testConfig({ models: [AUTHOR, POST] })}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <LocaleContext.Provider value={LOCALE}>{view}</LocaleContext.Provider>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    ),
  )
  await settle()
}

const editor = (model: ModelConfig): React.ReactElement => <EditView model={model} recordId="a1" onNavigate={() => {}} />
const buttons = (): string[] => [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim())
const nameInput = (): HTMLInputElement | null => container.querySelector<HTMLInputElement>("#field-name")

describe("a viewer opening a model record", () => {
  for (const model of [AUTHOR, POST]) {
    it(`gets ${model.label} read only, with no Save, Publish or Delete`, async () => {
      await render("viewer", editor(model))
      expect(nameInput()?.value).toBe("Ada")
      expect(nameInput()?.readOnly || nameInput()?.disabled).toBe(true)
      for (const label of WRITE_LABELS) expect(buttons()).not.toContain(label)
    })
  }

  it("is not offered Create on the list", async () => {
    await render("viewer", <ListView model={AUTHOR} onNavigate={() => {}} />)
    expect(container.textContent).toContain("Ada")
    expect(buttons()).not.toContain("Create Author")
  })
})

describe("an editor opening the same record", () => {
  it("still gets an editable form and Save", async () => {
    await render("editor", editor(AUTHOR))
    expect(nameInput()?.readOnly).toBe(false)
    expect(buttons()).toContain("Save")
  })

  it("is shown the refusal's own words under Details when a save is refused", async () => {
    await render("editor", editor(AUTHOR))
    const save = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save")
    await act(async () => save?.click())
    await settle()
    expect(container.textContent).toContain(REFUSED)
    expect(container.textContent).not.toContain("Request failed")
    expect(container.textContent).not.toContain("PostgREST error")
  })
})
