// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EditView } from "../src/views/EditView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import { isJsonObject } from "../src/lib/json.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * Fresh-user test 3, B2: `Author.email` is required and has only `read: Owner<"user_id">`. An editor's
 * Create Author form left Email out, so Save failed with "Email is required". The database judges
 * that rule against the new row on INSERT, so the server now answers `create: "row"` and the form
 * asks for the value. An existing record the editor does not own still shows the padlock.
 */

const LOCALE: LocaleState = { currentLocale: "en", defaultLocale: "en", locales: [{ code: "en", label: "English" }], setLocale: () => {} }
const AUTHOR = testModel({
  name: "author",
  label: "Author",
  tableName: "author",
  fields: [
    testField({ name: "id", widget: "uuid", readOnly: true }),
    testField({ name: "user_id", label: "User id", required: true }),
    testField({ name: "name", label: "Name", required: true }),
    testField({ name: "email", label: "Email", required: true }),
  ],
  listColumns: ["name"],
})
// What /studio/session answers an editor for this schema (studiobootstrap.resolveField).
const OWNER_READ = { author: { email: { read: "row", write: "row", create: "row" } } }
// What it answers a Studio editor when `email` is masked from them outright (`read: Role<"admin">`):
// every field is creatable in Studio mode, and existing records keep the padlock.
const MASKED = { author: { email: { read: "deny", write: "deny", create: "allow" } } }
let FIELDS: Record<string, unknown> = OWNER_READ
const OTHERS = { id: "a1", user_id: "u-owner", name: "Owner", email: null }
const NOT_OWNER = { id: "a1", can_read_author__email: false, can_write_author__email: false }

let inserts: Record<string, unknown>[] = []
let patches: Record<string, unknown>[] = []
let container: HTMLDivElement
let root: Root

function serve(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input.includes("/studio/session")) return Response.json({ mode: "studio", fields: FIELDS, access: {} })
    if (input.includes("/studio/auth/verify")) return Response.json({ role: "editor", seesDrafts: false, permissions: { write: true } })
    const body: unknown = init?.body === undefined ? null : JSON.parse(String(init.body))
    if (init?.method === "POST" && input.includes("/rest/v1/author") && isJsonObject(body)) {
      inserts.push(body)
      return Response.json([{ id: "a9", ...body }], { status: 201 })
    }
    if (init?.method === "PATCH" && isJsonObject(body)) {
      patches.push(body)
      return new Response(null, { status: 204 })
    }
    if (decodeURIComponent(input).includes("can_read_author__email")) return Response.json(NOT_OWNER)
    return Response.json([OTHERS])
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  inserts = []
  patches = []
  serve()
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

async function open(recordId?: string): Promise<void> {
  await act(async () =>
    root.render(
      <AdminConfigContext.Provider value={testConfig({ models: [AUTHOR] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <LocaleContext.Provider value={LOCALE}>
            <EditView model={AUTHOR} {...(recordId !== undefined && { recordId })} onNavigate={() => {}} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    ),
  )
  await settle()
}

const input = (name: string): HTMLInputElement | null => container.querySelector<HTMLInputElement>(`#field-${name}`)

async function type(name: string, text: string): Promise<void> {
  const box = input(name)
  if (box === null) throw new Error(`no input for ${name}`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(box, text)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function save(): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save")
  if (button === undefined) throw new Error("no Save button")
  await act(async () => { button.click() })
  await settle()
}

describe("an editor creating a record whose required column only the owner may read", () => {
  it("asks for the column on the create form and sends it", async () => {
    await open()
    expect(input("email")?.readOnly).toBe(false)
    await type("user_id", "u-editor")
    await type("name", "Made by editor")
    await type("email", "editor@fresh-cms.test")
    await save()
    expect(container.textContent).not.toContain("Email is required")
    expect(inserts).toEqual([{ user_id: "u-editor", name: "Made by editor", email: "editor@fresh-cms.test" }])
  })

  it("still shows the padlock, and leaves the column out of a save, on a record they do not own", async () => {
    await open("a1")
    expect(input("email")).toBeNull()
    const email = container.querySelector("label[for=field-email]")?.parentElement
    expect(email?.querySelector("[aria-label='Hidden by a field access rule']")).not.toBeNull()
    await save()
    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0] ?? {})).not.toContain("email")
  })
})

describe("a Studio editor creating a record with a field masked from them", () => {
  beforeEach(() => { FIELDS = MASKED })
  afterEach(() => { FIELDS = OWNER_READ })

  it("asks for the masked field on the create form and sends it", async () => {
    await open()
    expect(input("email")?.readOnly).toBe(false)
    await type("user_id", "u-other")
    await type("name", "Made for someone else")
    await type("email", "other@fresh-cms.test")
    await save()
    expect(inserts).toEqual([{ user_id: "u-other", name: "Made for someone else", email: "other@fresh-cms.test" }])
  })

  it("keeps the padlock on an existing record, and leaves the field out of a save", async () => {
    await open("a1")
    expect(input("email")).toBeNull()
    const email = container.querySelector("label[for=field-email]")?.parentElement
    expect(email?.querySelector("[aria-label='Hidden by a field access rule']")).not.toBeNull()
    await save()
    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0] ?? {})).not.toContain("email")
  })
})
