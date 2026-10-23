// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { EditView } from "../src/views/EditView.js"
import { ListView } from "../src/views/ListView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import { isJsonObject } from "../src/lib/json.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * Fresh-test local21 B2: the gateway answered `GET /studio/session` with Studio's index.html, the
 * JSON parse failed, and Studio carried on as if no column had a field rule. An editor met another
 * author's masked email as an empty, required, editable input, and a `-` in the list.
 *
 * With no answer, Studio now says it does not know: a column the REST response names as possibly
 * masked (X-Supatype-Masked-Fields) shows the "hidden or empty" padlock where its value is null,
 * is left out of a save, and the console says once why.
 */

const LOCALE: LocaleState = { currentLocale: "en", defaultLocale: "en", locales: [{ code: "en", label: "English" }], setLocale: () => {} }
const AUTHOR = testModel({
  name: "author",
  label: "Author",
  labelPlural: "Authors",
  tableName: "author",
  fields: [
    testField({ name: "id", widget: "uuid", readOnly: true }),
    testField({ name: "name", label: "Name" }),
    testField({ name: "email", label: "Email", required: true }),
  ],
  listColumns: ["name", "email"],
})
const ROW = { id: "a2", name: "Ada", email: null }
const INDEX_HTML = "<!doctype html><html><body><div id=root></div></body></html>"

let patches: Record<string, unknown>[] = []
let container: HTMLDivElement
let root: Root
let warn: MockInstance<typeof console.warn>

const INDEX_ANSWER = (): Response => new Response(INDEX_HTML, { headers: { "Content-Type": "text/html" } })
let sessionAnswer: () => Response = INDEX_ANSWER

function serve(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (input.includes("/studio/session")) return sessionAnswer()
    if (input.includes("/studio/auth/verify")) return Response.json({ role: "editor", permissions: { write: true } })
    if (init?.method === "PATCH") {
      const body: unknown = JSON.parse(String(init.body))
      if (isJsonObject(body)) patches.push(body)
      return new Response(null, { status: 204 })
    }
    return Response.json([ROW], { headers: { "X-Supatype-Masked-Fields": "email=row" } })
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  patches = []
  sessionAnswer = INDEX_ANSWER
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  warn.mockRestore()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function render(view: React.ReactElement): Promise<void> {
  serve()
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AdminConfigContext.Provider value={testConfig({ models: [AUTHOR] })}>
          <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
            <LocaleContext.Provider value={LOCALE}>{view}</LocaleContext.Provider>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    ),
  )
  await settle()
}

const UNKNOWN = "[aria-label='Hidden by a field access rule, or empty']"

describe("field access Studio could not read", () => {
  it("shows a possibly masked null on the form as the unknown padlock, not an empty input", async () => {
    await render(<EditView model={AUTHOR} recordId="a2" onNavigate={() => {}} />)
    expect(container.querySelector("#field-name")).not.toBeNull()
    expect(container.querySelector("#field-email")).toBeNull()
    expect(container.querySelector(UNKNOWN)).not.toBeNull()
  })

  it("leaves that column out of a save", async () => {
    await render(<EditView model={AUTHOR} recordId="a2" onNavigate={() => {}} />)
    const save = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save")
    await act(async () => save?.click())
    await settle()
    expect(patches).toHaveLength(1)
    expect(patches[0]).not.toHaveProperty("email")
  })

  it("shows the unknown padlock in the list", async () => {
    await render(<ListView model={AUTHOR} onNavigate={() => {}} />)
    expect(container.textContent).toContain("Ada")
    expect(container.querySelector(UNKNOWN)).not.toBeNull()
  })

  it("says why once, in the console", async () => {
    await render(<EditView model={AUTHOR} recordId="a2" onNavigate={() => {}} />)
    const said = warn.mock.calls.map((call) => String(call[0]))
    const about = said.filter((line) => line.includes("/studio/session"))
    expect(about).toHaveLength(1)
    expect(about[0]).toContain("text/html, not a JSON object")
  })
})

/**
 * The server now marks a session whose schema it could not read, rather than leaving out the
 * access keys, which read the same as a schema with no rules. A 200 with the marker is as unknown
 * as no answer at all.
 */
const NO_SCHEMA = "no schema state: push the schema first"

function sessionSaying(marker: Record<string, string>): () => Response {
  return () => Response.json({ role: "editor", mode: "self", ...marker })
}

function sessionWarnings(): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("/studio/session"))
}

describe("a session that marks its field access unavailable", () => {
  beforeEach(() => {
    sessionAnswer = sessionSaying({ fieldAccess: "unavailable", fieldAccessReason: NO_SCHEMA })
  })

  it("shows the unknown padlock on the form and leaves the column out of a save", async () => {
    await render(<EditView model={AUTHOR} recordId="a2" onNavigate={() => {}} />)
    expect(container.querySelector("#field-email")).toBeNull()
    expect(container.querySelector(UNKNOWN)).not.toBeNull()
    const save = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save")
    await act(async () => save?.click())
    await settle()
    expect(patches).toHaveLength(1)
    expect(patches[0]).not.toHaveProperty("email")
  })

  it("shows the unknown padlock in the list", async () => {
    await render(<ListView model={AUTHOR} onNavigate={() => {}} />)
    expect(container.textContent).toContain("Ada")
    expect(container.querySelector(UNKNOWN)).not.toBeNull()
  })

  it("says why once, with the server's reason", async () => {
    await render(<EditView model={AUTHOR} recordId="a2" onNavigate={() => {}} />)
    const about = sessionWarnings()
    expect(about).toHaveLength(1)
    expect(about[0]).toContain(NO_SCHEMA)
  })
})

describe.each([
  ["marks its field access available", { fieldAccess: "available" }],
  ["predates the marker", {}],
])("a session that %s", (_name, marker) => {
  beforeEach(() => {
    sessionAnswer = sessionSaying(marker)
  })

  it("reads as resolved with no rules: an editable input, no padlock and no warning", async () => {
    await render(<EditView model={AUTHOR} recordId="a2" onNavigate={() => {}} />)
    expect(container.querySelector("#field-email")).not.toBeNull()
    expect(container.querySelector(UNKNOWN)).toBeNull()
    expect(sessionWarnings()).toHaveLength(0)
  })

  it("shows no padlock in the list", async () => {
    await render(<ListView model={AUTHOR} onNavigate={() => {}} />)
    expect(container.textContent).toContain("Ada")
    expect(container.querySelector(UNKNOWN)).toBeNull()
  })
})
