// Server-renders Input and checks the ids and ARIA wiring in the markup.
import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createElement, Fragment } from "react"
import { renderToString } from "react-dom/server"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { Input } = await import(pathToFileURL(join(pkgDir, "dist/index.js")).href)

/** The value of every `name="..."` attribute in the markup, in order. */
function attrs(html, name) {
  return [...html.matchAll(new RegExp(`[ ]${name}="([^"]*)"`, "g"))].map((m) => m[1])
}

test("two inputs with the same label get distinct ids, each label pointing at its own", () => {
  const html = renderToString(
    createElement(Fragment, null, createElement(Input, { label: "Email" }), createElement(Input, { label: "Email" })),
  )
  const ids = attrs(html, "id")
  const fors = attrs(html, "for")
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual(fors, ids)
})

test("a caller's id is used as given", () => {
  const html = renderToString(createElement(Input, { label: "Email", id: "signup-email" }))
  assert.deepEqual(attrs(html, "id"), ["signup-email"])
  assert.deepEqual(attrs(html, "for"), ["signup-email"])
})

test("an error is announced: aria-invalid, and aria-describedby names the error text", () => {
  const html = renderToString(createElement(Input, { label: "Email", id: "e", error: "Required" }))
  assert.deepEqual(attrs(html, "aria-invalid"), ["true"])
  assert.deepEqual(attrs(html, "aria-describedby"), ["e-error"])
  assert.match(html, /<p[^>]*\sid="e-error"[^>]*>Required<\/p>/)
})

test("a caller's aria-describedby is kept alongside the error", () => {
  const html = renderToString(
    createElement(Input, { id: "e", error: "Required", "aria-describedby": "e-hint" }),
  )
  assert.deepEqual(attrs(html, "aria-describedby"), ["e-hint e-error"])
})

test("no error, no aria-invalid and no added description", () => {
  const html = renderToString(createElement(Input, { id: "e", "aria-describedby": "e-hint" }))
  assert.deepEqual(attrs(html, "aria-invalid"), [])
  assert.deepEqual(attrs(html, "aria-describedby"), ["e-hint"])
})
