// @vitest-environment jsdom
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import type { ActingMode } from "../src/lib/acting-mode.js"
import { ListView } from "../src/views/ListView.js"
import { isolateEachTest, mount, settle, testClient, testConfig, testField, testModel } from "./support.js"

/**
 * C19 (fresh-test): `author.email` is readable by its owner only. An editor or viewer on the Author
 * list saw another author's withheld email as a blank, while the edit form showed the padlock. The
 * list now asks the page's records the same per-row question the form asks one record.
 */

isolateEachTest()

const AUTHOR = testModel({
  name: "author",
  label: "Author",
  labelPlural: "Authors",
  tableName: "author",
  fields: [testField({ name: "name", label: "Name" }), testField({ name: "email", label: "Email" })],
  listColumns: ["name", "email"],
})
const FIELDS = { author: { email: { read: "row", write: "row", create: "allow" } } }
const ROWS = [
  { id: "a1", name: "Mine", email: "me@example.com" },
  { id: "a2", name: "Theirs", email: null },
  { id: "a3", name: "Mine, no email", email: null },
]
const ANSWERS = [
  { id: "a1", can_read_author__email: true },
  { id: "a2", can_read_author__email: false },
  { id: "a3", can_read_author__email: true },
]

let affordanceAsks = 0

function serve(mode: ActingMode): void {
  affordanceAsks = 0
  vi.stubGlobal("fetch", async (input: string) => {
    if (input.includes("/studio/session")) return Response.json({ mode, fields: FIELDS, access: {} })
    if (decodeURIComponent(input).includes("can_read_author__email")) {
      affordanceAsks++
      return Response.json(ANSWERS)
    }
    return Response.json(ROWS)
  })
}

async function renderAuthors(mode: ActingMode): Promise<HTMLElement> {
  serve(mode)
  const { container } = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={testConfig({ models: [AUTHOR] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <LocaleContext.Provider value={{ currentLocale: "en", setLocale: () => undefined, locales: [], defaultLocale: "en" }}>
            <ListView model={AUTHOR} onNavigate={() => undefined} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return container
}

function emailCell(container: HTMLElement, name: string): Element | null {
  const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) => tr.textContent?.includes(name))
  return row?.querySelectorAll("td")[2] ?? null
}

describe("a list column restricted per record", () => {
  it("shows the padlock the edit form shows where the record withholds the value", async () => {
    const container = await renderAuthors("studio")
    const cell = emailCell(container, "Theirs")
    expect(cell?.querySelector("[aria-label='Hidden by a field access rule']")).not.toBeNull()
  })

  it("shows an empty value as empty where the record lets the caller read it", async () => {
    const container = await renderAuthors("studio")
    const cell = emailCell(container, "Mine, no email")
    expect(cell?.querySelector("[aria-label^='Hidden by a field access rule']")).toBeNull()
    expect(emailCell(container, "Mine")?.textContent).toContain("me@example.com")
  })

  it("asks nothing of the records for an elevated caller", async () => {
    await renderAuthors("elevated")
    expect(affordanceAsks).toBe(0)
  })
})
