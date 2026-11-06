// Checks Select, Textarea and Checkbox: label and error wiring from server markup, and the
// checked state and chosen value from a jsdom mount.
import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>")
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { act, createElement, Fragment } = await import("react")
const { renderToString } = await import("react-dom/server")
const { createRoot } = await import("react-dom/client")
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ui = await import(pathToFileURL(join(pkgDir, "dist/index.js")).href)

/** The value of every `name="..."` attribute in the markup, in order. */
function attrs(html, name) {
  return [...html.matchAll(new RegExp(`[ ]${name}="([^"]*)"`, "g"))].map((m) => m[1])
}

/** Mount `element` in jsdom; returns the host node and an unmount function. */
async function mount(element) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  return { host, unmount: () => act(async () => root.unmount()) }
}

const options = [createElement("option", { key: "a", value: "a" }, "A"), createElement("option", { key: "b", value: "b" }, "B")]

/** Each control, with what it needs to render, and the tag of the native element it wraps. */
const controls = {
  Select: { tag: "SELECT", render: (props) => createElement(ui.Select, props, ...options) },
  Textarea: { tag: "TEXTAREA", render: (props) => createElement(ui.Textarea, props) },
  Checkbox: { tag: "INPUT", render: (props) => createElement(ui.Checkbox, props) },
}

for (const [name, { tag, render }] of Object.entries(controls)) {
  test(`${name}: is exported`, () => {
    assert.notEqual(ui[name], undefined, `${name} is not exported from @supatype/ui`)
  })

  test(`${name}: two with the same label get distinct ids, each label pointing at its own`, () => {
    const html = renderToString(createElement(Fragment, null, render({ label: "Role" }), render({ label: "Role" })))
    const ids = attrs(html, "id")
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
    assert.deepEqual(attrs(html, "for"), ids)
  })

  test(`${name}: a caller's id is used as given`, () => {
    const html = renderToString(render({ label: "Role", id: "role" }))
    assert.deepEqual(attrs(html, "id"), ["role"])
    assert.deepEqual(attrs(html, "for"), ["role"])
  })

  test(`${name}: an error is announced through aria-invalid and aria-describedby`, () => {
    const html = renderToString(render({ label: "Role", id: "r", error: "Required", "aria-describedby": "r-hint" }))
    assert.deepEqual(attrs(html, "aria-invalid"), ["true"])
    assert.deepEqual(attrs(html, "aria-describedby"), ["r-hint r-error"])
    assert.match(html, /<p[^>]*\sid="r-error"[^>]*>Required<\/p>/)
  })

  test(`${name}: no error, no aria-invalid and no error id`, () => {
    const html = renderToString(render({ label: "Role", id: "r" }))
    assert.deepEqual(attrs(html, "aria-invalid"), [])
    assert.deepEqual(attrs(html, "aria-describedby"), [])
  })

  test(`${name}: forwards its ref to the native control`, async () => {
    const ref = { current: null }
    const { unmount } = await mount(render({ label: "Role", ref }))
    assert.equal(ref.current?.tagName, tag)
    await unmount()
  })
}

test("Checkbox toggles from its label and its box, and reports the checked state", async () => {
  const seen = []
  const onChange = (event) => seen.push(event.target.checked)
  const { host, unmount } = await mount(createElement(ui.Checkbox, { label: "Subscribe", onChange }))
  const box = host.querySelector("input")
  assert.equal(box.type, "checkbox")
  assert.equal(box.checked, false)
  await act(async () => host.querySelector("label").click())
  assert.equal(box.checked, true)
  await act(async () => box.click())
  assert.equal(box.checked, false)
  assert.deepEqual(seen, [true, false])
  await unmount()
})

test("Select reports the chosen value", async () => {
  const seen = []
  const onChange = (event) => seen.push(event.target.value)
  const { host, unmount } = await mount(createElement(ui.Select, { label: "Role", defaultValue: "a", onChange }, ...options))
  const select = host.querySelector("select")
  assert.equal(select.value, "a")
  await act(async () => {
    select.value = "b"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  assert.equal(select.value, "b")
  assert.deepEqual(seen, ["b"])
  await unmount()
})
