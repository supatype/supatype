// Mounts the built RichTextEditor in jsdom and checks what changes after mount.
import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { act, createElement } = await import("react")
const { createRoot } = await import("react-dom/client")
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { RichTextEditor } = await import(pathToFileURL(join(pkgDir, "dist/rich-text.js")).href)

/** Render the editor with `props`, returning a function that renders it again with new props. */
async function mount(props) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = (next) => act(async () => root.render(createElement(RichTextEditor, { onChange: () => {}, ...next })))
  await render(props)
  return { host, render, unmount: () => act(async () => root.unmount()) }
}

const surface = (host) => host.querySelector(".su-richtext-editable")

test("the editor follows `editable` after mount, not only at it", async () => {
  const { host, render, unmount } = await mount({ editable: false })
  assert.equal(surface(host)?.getAttribute("contenteditable"), "false")

  await render({ editable: true })
  assert.equal(surface(host)?.getAttribute("contenteditable"), "true")
  const titles = [...host.querySelectorAll(".su-richtext-toolbar button")].map((b) => b.getAttribute("title"))
  assert.deepEqual(titles, ["Bold", "Italic", "Underline", "Heading 1", "Heading 2", "Paragraph", "Bullet list", "Numbered list"])

  await render({ editable: false })
  assert.equal(surface(host)?.getAttribute("contenteditable"), "false")
  assert.equal(host.querySelector(".su-richtext-toolbar"), null)
  await unmount()
})
