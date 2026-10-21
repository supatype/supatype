// @vitest-environment jsdom
import React, { act } from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import { ListView } from "../src/views/ListView.js"
import { button } from "./data-browser-support.js"
import { isolateEachTest, mount, settle, testClient, testConfig, testField, testModel, unmount, type Mounted } from "./support.js"

/**
 * Deleting selected rows ignored the `{ error }` the client returns instead of throwing, so a delete
 * a policy or a foreign key refused looked like it had worked. It also deleted on the first press,
 * with no question asked. It now asks first, and a refusal is shown with the row kept selected.
 */

const MODEL = testModel({ fields: [testField({ name: "title", label: "Title" })], listColumns: ["title"] })
const REFUSAL = "update or delete on table \"posts\" violates foreign key constraint"

/** The list on screen and every DELETE it has sent. */
interface RefusingList extends Mounted {
  deletes: URL[]
}

isolateEachTest()

const FIRST = { id: "p1", title: "First post" }

async function renderRefusingList(rows: Array<{ id: string; title: string }> = [FIRST]): Promise<RefusingList> {
  const deletes: URL[] = []
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deletes.push(new URL(raw))
      return Response.json({ code: "23503", message: REFUSAL, details: null, hint: null }, { status: 409 })
    }
    return Response.json(rows)
  })
  const view = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={testConfig({ models: [MODEL] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <LocaleContext.Provider value={{ currentLocale: "en", setLocale: () => undefined, locales: [], defaultLocale: "en" }}>
            <ListView model={MODEL} onNavigate={() => undefined} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return { ...view, deletes }
}

async function selectFirstRowAndAskToDelete(container: HTMLElement): Promise<void> {
  const box = container.querySelector<HTMLInputElement>("input[aria-label='Select row p1']")
  if (!box) throw new Error("no row checkbox")
  await act(async () => box.click())
  await act(async () => button(container, "Delete selected").click())
}

describe("deleting selected rows from a list", () => {
  it("asks before deleting anything", async () => {
    const list = await renderRefusingList()
    await selectFirstRowAndAskToDelete(list.container)
    expect(list.container.querySelector("[role='alertdialog']")?.textContent).toContain("Delete 1")
    expect(list.deletes).toHaveLength(0)
  })

  it("speaks of one row in the singular and of several in the plural (final15)", async () => {
    // One row read "Delete 1 Talk? They are deleted for good."
    const single = await renderRefusingList()
    await selectFirstRowAndAskToDelete(single.container)
    const one = single.container.querySelector("[role='alertdialog']")?.textContent ?? ""
    expect(one).toContain("Delete 1 Post?")
    expect(one).toContain("It is deleted for good.")
    unmount(single)
    const { container } = await renderRefusingList([FIRST, { id: "p2", title: "Second post" }])
    const all = container.querySelector<HTMLInputElement>("input[aria-label='Select all']")
    if (!all) throw new Error("no select-all checkbox")
    await act(async () => all.click())
    await act(async () => button(container, "Delete selected").click())
    const two = container.querySelector("[role='alertdialog']")?.textContent ?? ""
    expect(two).toContain("Delete 2 Posts?")
    expect(two).toContain("They are deleted for good.")
  })

  it("shows a refused delete and keeps the row selected", async () => {
    const { container, deletes } = await renderRefusingList()
    await selectFirstRowAndAskToDelete(container)
    const dialog = container.querySelector<HTMLElement>("[role='alertdialog']")
    if (!dialog) throw new Error("no confirmation")
    await act(async () => button(dialog, "Delete").click())
    await settle()
    expect(deletes).toHaveLength(1)
    expect(container.querySelector("[role='alert']")?.textContent).toContain(REFUSAL)
    expect(container.querySelector<HTMLInputElement>("input[aria-label='Select row p1']")?.checked).toBe(true)
  })
})
