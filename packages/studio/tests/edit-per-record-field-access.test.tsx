// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EditView } from "../src/views/EditView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import type { ActingMode } from "../src/lib/acting-mode.js"
import { isJsonObject } from "../src/lib/json.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * kitchen-sink's `attendee.phone` is readable and writable by its owner only. An editor acting as
 * themselves who opened someone else's attendee met Phone as an empty, editable input: the edit
 * form read a per-row verdict as allowed, where the list already showed a padlock. The form now
 * asks the record itself, through the engine's `can_read_` / `can_write_` functions.
 */

const LOCALE: LocaleState = { currentLocale: "en", defaultLocale: "en", locales: [{ code: "en", label: "English" }], setLocale: () => {} }
const ATTENDEE = testModel({
  name: "attendee",
  label: "Attendee",
  tableName: "attendee",
  fields: [
    testField({ name: "id", widget: "uuid", readOnly: true }),
    testField({ name: "name", label: "Name" }),
    testField({ name: "phone", label: "Phone", required: true }),
    testField({ name: "email", label: "Email" }),
  ],
  listColumns: ["name"],
})
const FIELDS = {
  attendee: {
    phone: { read: "row", write: "row", create: "allow" },
    email: { read: "allow", write: "row", create: "allow" },
  },
}
// Someone else's record: masking returned phone as null.
const ROW = { id: "a2", name: "Bob", phone: null, email: "bob@example.com" }
const NOT_OWNER = { id: "a2", can_read_attendee__phone: false, can_write_attendee__phone: false, can_write_attendee__email: false }

let patches: Record<string, unknown>[] = []
let affordanceAsks = 0
let container: HTMLDivElement
let root: Root

function serve(mode: ActingMode): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input.includes("/studio/session")) return Response.json({ mode, fields: FIELDS, access: {} })
    if (input.includes("/studio/auth/verify")) return Response.json({ role: "editor", seesDrafts: false, permissions: { write: true } })
    if (init?.method === "PATCH") {
      const body: unknown = JSON.parse(String(init.body))
      if (isJsonObject(body)) patches.push(body)
      return new Response(null, { status: 204 })
    }
    if (decodeURIComponent(input).includes("can_read_attendee__phone")) {
      affordanceAsks++
      return Response.json(NOT_OWNER)
    }
    return Response.json([ROW])
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  patches = []
  affordanceAsks = 0
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

async function open(mode: ActingMode): Promise<void> {
  serve(mode)
  await act(async () =>
    root.render(
      <AdminConfigContext.Provider value={testConfig({ models: [ATTENDEE] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <LocaleContext.Provider value={LOCALE}>
            <EditView model={ATTENDEE} recordId="a2" onNavigate={() => {}} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    ),
  )
  await settle()
}

const input = (name: string): HTMLInputElement | null => container.querySelector<HTMLInputElement>(`#field-${name}`)

async function save(): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save")
  if (button === undefined) throw new Error("no Save button")
  await act(async () => { button.click() })
  await settle()
}

describe("editing a record whose fields are restricted per record", () => {
  it("shows a column this record withholds as the padlock, with no input", async () => {
    await open("self")
    expect(input("phone")).toBeNull()
    const phone = [...container.querySelectorAll(".st-field")].find(
      (f) => f.querySelector(".st-field-label")?.textContent === "Phone",
    )
    expect(phone?.querySelector("[aria-label='Hidden by a field access rule']")).not.toBeNull()
  })

  it("makes a column readable but not writable on this record read only", async () => {
    await open("self")
    expect(input("email")?.value).toBe("bob@example.com")
    expect(input("email")?.readOnly).toBe(true)
    expect(input("name")?.readOnly).toBe(false)
  })

  it("saves without the columns the caller cannot write on this record", async () => {
    await open("self")
    await save()
    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0] ?? {})).toEqual(["name"])
  })

  it("leaves an elevated caller's form as it was, without asking the record", async () => {
    await open("elevated")
    expect(affordanceAsks).toBe(0)
    expect(input("phone")?.readOnly).toBe(false)
    expect(input("email")?.readOnly).toBe(false)
  })
})
