// Mounts the Table parts in jsdom and checks each renders the element, and so the role, it names.
import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "Node", "HTMLElement"]) {
  Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { act, createElement: h } = await import("react")
const { createRoot } = await import("react-dom/client")
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ui = await import(pathToFileURL(join(pkgDir, "dist/index.js")).href)

/** The implicit ARIA role of each table element, by tag. */
const ROLE = { TABLE: "table", THEAD: "rowgroup", TBODY: "rowgroup", TR: "row", TH: "columnheader", TD: "cell" }

test("the table parts are exported", () => {
  for (const name of ["Table", "THead", "TBody", "Tr", "Th", "Td"]) {
    assert.notEqual(ui[name], undefined, `${name} is not exported from @supatype/ui`)
  }
})

test("Table renders header and body cells with the table roles", async () => {
  const { Table, THead, TBody, Tr, Th, Td } = ui
  const tableRef = { current: null }
  const tree = h(Table, { ref: tableRef, "aria-label": "Users" },
    h(THead, null, h(Tr, null, h(Th, { scope: "col" }, "Name"), h(Th, { scope: "col" }, "Email"))),
    h(TBody, null, h(Tr, null, h(Td, null, "Ada"), h(Td, null, "ada@example.com"))),
  )
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(tree))

  const table = host.querySelector("table")
  assert.equal(tableRef.current, table)
  assert.equal(ROLE[table.tagName], "table")
  assert.equal(table.getAttribute("aria-label"), "Users")
  const roles = [...table.querySelectorAll("*")].map((el) => ROLE[el.tagName])
  assert.deepEqual(roles, ["rowgroup", "row", "columnheader", "columnheader", "rowgroup", "row", "cell", "cell"])
  assert.deepEqual([...table.querySelectorAll("thead th")].map((th) => th.textContent), ["Name", "Email"])
  assert.deepEqual([...table.querySelectorAll("tbody td")].map((td) => td.textContent), ["Ada", "ada@example.com"])
  assert.equal(table.querySelector("th").getAttribute("scope"), "col")
  await act(async () => root.unmount())
})
