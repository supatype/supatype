// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EditView } from "../src/views/EditView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import type { ModelConfig } from "../src/config.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * A draft may leave a required field empty: the table's NOT NULL only holds once it is published.
 * Studio saved such a draft without a word and the editor learnt at Publish that it could not go
 * live. Saving one now asks first, naming the empty fields. A model without drafts is unchanged:
 * nothing is asked, and the save goes to the database, whose refusal says the field is required.
 */

const LOCALE: LocaleState = { currentLocale: "en", defaultLocale: "en", locales: [{ code: "en", label: "English" }], setLocale: () => {} }
const FIELDS = [
  testField({ name: "id", widget: "uuid", readOnly: true }),
  testField({ name: "name", label: "Name", required: true }),
  testField({ name: "slug", label: "Slug", widget: "slug", required: true, options: { from: "name" } }),
  testField({ name: "email", label: "Email", required: true }),
  testField({ name: "bio", label: "Bio" }),
]
const DRAFTS: ModelConfig = testModel({
  name: "speaker",
  tableName: "speaker",
  fields: FIELDS,
  listColumns: ["name"],
  versions: { drafts: true, keep: 20, versionsTable: "speaker_versions", localizedColumns: [] },
})
// The slug is blank, as one cleared in the editor: its source fills it, so it is not missing.
const ROW = { id: "r1", name: "Ada", slug: null, email: null, bio: null }

let writes: string[] = []
let container: HTMLDivElement
let root: Root

function serve(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input.includes("/studio/auth/verify")) return Response.json({ role: "admin", seesDrafts: true })
    const rpc = /\/rpc\/(\w+)/.exec(input)?.[1]
    if (rpc !== undefined) {
      writes.push(rpc)
      return Response.json({})
    }
    if (init?.method === "PATCH") {
      writes.push("PATCH")
      return Response.json({ code: "23502", message: 'null value in column "email" of relation "speaker" violates not-null constraint' }, { status: 400 })
    }
    if (input.includes("/speaker_versions")) return Response.json([])
    return Response.json([ROW])
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  writes = []
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
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function open(model: ModelConfig): Promise<void> {
  serve()
  await act(async () =>
    root.render(
      <AdminConfigContext.Provider value={testConfig({ models: [model] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <LocaleContext.Provider value={LOCALE}>
            <EditView model={model} recordId="r1" onNavigate={() => {}} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    ),
  )
  await settle()
}

async function click(label: string, within: ParentNode = document.body): Promise<void> {
  const target = [...within.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label)
  if (target === undefined) throw new Error(`no button "${label}" in: ${document.body.textContent ?? ""}`)
  await act(async () => { target.click() })
  await settle()
}

const dialog = (): Element | null => document.body.querySelector('[role="dialog"]')

describe("saving a draft with a required field empty", () => {
  it("asks first, naming the empty field, and saves nothing yet", async () => {
    await open(DRAFTS)
    await click("Save draft")
    expect(dialog()?.textContent).toContain("Save an incomplete draft?")
    expect(dialog()?.textContent).toContain("Email")
    expect(dialog()?.textContent).not.toContain("Name")
    expect(dialog()?.textContent).not.toContain("Slug")
    expect(writes).toEqual([])
  })

  it("saves the draft once answered", async () => {
    await open(DRAFTS)
    await click("Save draft")
    const asked = dialog()
    if (asked === null) throw new Error("not asked")
    await click("Save incomplete draft", asked)
    expect(writes).toEqual(["create_draft"])
    expect(dialog()).toBeNull()
  })

  it("saves nothing when cancelled", async () => {
    await open(DRAFTS)
    await click("Save draft")
    const asked = dialog()
    if (asked === null) throw new Error("not asked")
    await click("Cancel", asked)
    expect(writes).toEqual([])
    expect(dialog()).toBeNull()
  })

  it("does not count a blank slug its source will fill", async () => {
    await open({ ...DRAFTS, fields: FIELDS.filter((f) => f.name !== "email") })
    await click("Save draft")
    expect(dialog()).toBeNull()
    expect(writes).toEqual(["create_draft"])
  })
})

describe("a model without drafts", () => {
  it("asks nothing, and the database's refusal says the field is required", async () => {
    await open({ ...DRAFTS, versions: null })
    await click("Save")
    expect(dialog()).toBeNull()
    expect(writes).toEqual(["PATCH"])
    expect(document.body.querySelector("#field-email-error")?.textContent).toBe("is required")
  })
})
