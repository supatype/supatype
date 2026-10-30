// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EditView } from "../src/views/EditView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * `/models/Post/access` is not a record: the segment lands in the edit route as a record id. It
 * showed an edit form with Postgres's `invalid input syntax for type uuid: "access"` above it, and a
 * well-formed id with no row behind it showed the same empty form. Both are "not found".
 */

const LOCALE: LocaleState = { currentLocale: "en", defaultLocale: "en", locales: [{ code: "en", label: "English" }], setLocale: () => {} }
const fields = [testField({ name: "id", widget: "uuid", readOnly: true }), testField({ name: "name", label: "Name" })]
const POST = testModel({ name: "post", label: "Post", labelPlural: "Posts", tableName: "post", fields, listColumns: ["name"] })
const PERMISSIONS = { read: true, write: true }

let container: HTMLDivElement
let root: Root

/** Serves the Studio session, and answers the record read with `record`. */
function serve(record: Response): void {
  vi.stubGlobal("fetch", async (input: string) => {
    if (input.includes("/studio/session")) return Response.json({ mode: "studio", fields: {}, access: {} })
    if (input.includes("/studio/auth/verify")) return Response.json({ role: "owner", seesDrafts: true, permissions: PERMISSIONS })
    return record.clone()
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

async function open(recordId: string): Promise<void> {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={testConfig({ models: [POST] })}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <LocaleContext.Provider value={LOCALE}>
              <EditView model={POST} recordId={recordId} onNavigate={() => {}} />
            </LocaleContext.Provider>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    ),
  )
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const nameInput = (): HTMLInputElement | null => container.querySelector<HTMLInputElement>("#field-name")

describe("opening a record that is not there", () => {
  it("says a segment that is not an id is not found, with no form and no Postgres error", async () => {
    serve(Response.json({ code: "22P02", message: 'invalid input syntax for type uuid: "access"' }, { status: 400 }))
    await open("access")
    expect(container.textContent).toContain('Post "access" not found')
    expect(container.textContent).not.toContain("invalid input syntax")
    expect(nameInput()).toBeNull()
  })

  it("says a well-formed id with no row is not found", async () => {
    const missing = "00000000-0000-4000-8000-000000000000"
    serve(Response.json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, { status: 406 }))
    await open(missing)
    expect(container.textContent).toContain(`Post "${missing}" not found`)
    expect(nameInput()).toBeNull()
  })

  it("still opens a record that is there", async () => {
    serve(Response.json([{ id: "a1", name: "Ada" }]))
    await open("a1")
    expect(nameInput()?.value).toBe("Ada")
  })

  it("still reports a failure that is not a missing record", async () => {
    serve(Response.json({ code: "42501", message: "permission denied for table post" }, { status: 403 }))
    await open("a1")
    expect(container.textContent).not.toContain("not found")
    expect(nameInput()).not.toBeNull()
  })
})
