import { readFileSync } from "node:fs"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DateWidget } from "../src/widgets/DateWidget.js"
import { testField } from "./support.js"

/**
 * Date and time fields look the same everywhere, in the theme Studio has.
 *
 * Studio's tokens are a dark theme, and native date inputs drew a light-mode calendar icon (black on
 * the dark field) because nothing told the browser. Read-only ones (Record info) showed no icon at
 * all, so the two kinds of field disagreed on the same screen.
 */

const css = readFileSync(new URL("../src/globals.css", import.meta.url), "utf8")

/** The body of the first `:root { ... }` block. */
function rootBlock(text: string): string {
  const start = text.indexOf(":root {")
  return start === -1 ? "" : text.slice(start, text.indexOf("}", start))
}

describe("the theme and native date controls", () => {
  it("tells the browser its tokens are dark, so native pickers draw in the same scheme", () => {
    expect(rootBlock(css)).toMatch(/color-scheme:\s*dark;/)
  })

  it("hides the picker icon on every read-only date field, by one rule", () => {
    expect(css).toMatch(/input\[readonly\]::-webkit-calendar-picker-indicator\s*\{\s*display:\s*none;\s*\}/)
  })
})

describe("the date widget", () => {
  const render = (readOnly: boolean, widget: "date" | "datetime"): string =>
    renderToStaticMarkup(
      <DateWidget config={testField({ name: "created_at", widget })} value="2026-10-15T15:49:00Z" onChange={() => {}} readOnly={readOnly} />,
    )

  it("renders editable and read-only fields as the same input, read-only marked so the rule applies", () => {
    for (const widget of ["date", "datetime"] as const) {
      const editable = render(false, widget)
      const locked = render(true, widget)
      expect(editable).toContain('data-ui="input"')
      expect(locked).toContain('data-ui="input"')
      expect(locked).toContain("readOnly")
      expect(editable).not.toContain("readOnly")
    }
  })
})
