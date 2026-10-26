// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RichTextWidget } from "../src/widgets/RichTextWidget.js"
import { testField } from "./support.js"

/**
 * Opening a record is not editing it.
 *
 * The rich text widget loads its saved value into the editor after mount, and the editor's change
 * listener reported that load as an edit. The edit view counts edits to say "Changed" and to offer
 * "Publish changes", so every record with rich text read as changed the moment it opened.
 */

const SAVED = {
  root: {
    type: "root",
    version: 1,
    direction: null,
    format: "",
    indent: 0,
    children: [
      {
        type: "paragraph",
        version: 1,
        direction: null,
        format: "",
        indent: 0,
        textFormat: 0,
        textStyle: "",
        children: [{ type: "text", version: 1, text: "Saved words", detail: 0, format: 0, mode: "normal", style: "" }],
      },
    ],
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("the rich text widget", () => {
  it("does not report loading its saved value as a change", async () => {
    const onChange = vi.fn()
    await act(async () => {
      root.render(<RichTextWidget config={testField({ name: "abstract", widget: "richtext" })} value={SAVED} onChange={onChange} readOnly={false} />)
    })
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    expect(container.textContent).toContain("Saved words")
    expect(onChange).not.toHaveBeenCalled()
  })
})
