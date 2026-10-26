// @vitest-environment jsdom
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { UuidCell } from "../src/components/UuidCell.js"
import { isUuid, shortUuid } from "../src/lib/uuid.js"
import { renderBrowser } from "./data-browser-support.js"
import { renderList } from "./list-view-support.js"
import { act, isolateEachTest, mount, settle, testField, testModel } from "./support.js"

/**
 * A UUID in a table cell is 36 characters of noise that pushes every other column off the screen.
 * Cells show its last five characters, the whole value on hover, and a button that copies it.
 * The tail rather than the head: a v7 UUID's head is its timestamp, so rows made together share
 * it, while the tail is the random part that tells them apart.
 */

const ID = "0191f2a4-7c3e-7b10-9d2e-5a8c1e43f9a2"
const OWNER = "6b1d0c9e-2f4a-4e8b-b7d1-90ac3e5f1b77"

isolateEachTest()

/** Mounts `node` and returns the container it rendered into. */
async function render(node: React.ReactElement): Promise<HTMLElement> {
  return (await mount(node)).container
}

/** The copy button for `id`, found by the name a screen reader hears. */
function copyButton(scope: HTMLElement, id: string): HTMLButtonElement {
  const found = scope.querySelector<HTMLButtonElement>(`button[aria-label="Copy ${id}"]`)
  if (!found) throw new Error(`no copy button for ${id}`)
  return found
}

describe("isUuid and shortUuid", () => {
  it("knows a UUID in either case and nothing else", () => {
    expect(isUuid(ID)).toBe(true)
    expect(isUuid(ID.toUpperCase())).toBe(true)
    expect(isUuid(`${ID} `)).toBe(false)
    expect(isUuid("p1")).toBe(false)
    expect(isUuid(42)).toBe(false)
  })

  it("keeps the last five characters behind an ellipsis", () => {
    expect(shortUuid(ID)).toBe("…3f9a2")
  })
})

describe("UuidCell", () => {
  it("shows the tail, with the whole value on hover", async () => {
    const container = await render(<UuidCell value={ID} />)
    expect(container.textContent).toContain("…3f9a2")
    expect(container.textContent).not.toContain(ID)
    expect(container.querySelector(`[title="${ID}"]`)?.textContent).toBe("…3f9a2")
  })

  it("copies the whole value, says so, and does not click the row it sits in", async () => {
    const writes: string[] = []
    vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => { writes.push(text) } } })
    const rowClicks = vi.fn()
    const container = await render(<div onClick={rowClicks}><UuidCell value={ID} /></div>)
    await act(async () => { copyButton(container, ID).click() })
    expect(writes).toEqual([ID])
    expect(rowClicks).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copied")
  })

  it("is a real button, so the keyboard reaches it", async () => {
    const container = await render(<UuidCell value={ID} />)
    const btn = copyButton(container, ID)
    expect(btn.tagName).toBe("BUTTON")
    expect(btn.getAttribute("type")).toBe("button")
  })

  it("leaves a value that is not a UUID as it is", async () => {
    const container = await render(<UuidCell value="p1" />)
    expect(container.textContent).toBe("p1")
    expect(container.querySelector("button")).toBeNull()
  })
})

describe("model list cells", () => {
  it("shortens a UUID key and a relation to their tails", async () => {
    const model = testModel({
      fields: [testField({ name: "title" }), testField({ name: "owner", widget: "relation" })],
      listColumns: ["title", "owner"],
    })
    const list = await renderList(model, [{ id: ID, title: "First", owner: OWNER }])
    const table = list.container.querySelector("tbody")!
    expect(table.textContent).toContain("…f1b77")
    expect(table.textContent).not.toContain(OWNER)
    expect(copyButton(table, OWNER)).toBeTruthy()
  })
})

describe("data browser cells", () => {
  it("shortens a UUID primary key and a foreign key, keeping the foreign key a link", async () => {
    const browser = await renderBrowser({ rows: [{ id: ID, owner_id: OWNER, body: "hello" }], columns: uuidColumns() })
    await settle()
    const body = browser.container.querySelector("tbody")!
    expect(body.textContent).toContain("…3f9a2")
    expect(body.textContent).toContain("…f1b77")
    expect(body.textContent).not.toContain(ID)
    expect(copyButton(body, ID)).toBeTruthy()
    expect(body.querySelector(`button[title="View in users: ${OWNER}"]`)?.textContent).toBe("…f1b77")
  })
})

function uuidColumns(): Record<string, unknown>[] {
  const base = { table_name: "message", table_schema: "public", is_nullable: "NO", column_default: null, is_primary: false, is_foreign_key: false, references_col: null, is_unique: false, row_count: 1 }
  return [
    { ...base, column_name: "id", udt_name: "uuid", is_primary: true },
    { ...base, column_name: "owner_id", udt_name: "uuid", is_foreign_key: true, references_col: "users.id" },
    { ...base, column_name: "body", udt_name: "text" },
  ]
}
