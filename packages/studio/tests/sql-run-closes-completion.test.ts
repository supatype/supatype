// @vitest-environment jsdom
import { autocompletion, completionStatus, startCompletion } from "@codemirror/autocomplete"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { runAndCloseCompletion } from "../src/views/SqlRunner.js"

/**
 * Fresh-test cosmetic: running a query with Mod-Enter left the autocomplete list open over the
 * editor. Running now closes it first.
 */

async function viewWithOpenCompletion(): Promise<EditorView> {
  const view = new EditorView({
    state: EditorState.create({
      doc: "sel",
      selection: { anchor: 3 },
      extensions: [autocompletion({ override: [() => ({ from: 0, options: [{ label: "select" }] })] })],
    }),
    parent: document.body,
  })
  startCompletion(view)
  for (let i = 0; i < 20 && completionStatus(view.state) !== "active"; i++) await new Promise((r) => setTimeout(r, 20))
  return view
}

describe("running from the SQL editor", () => {
  it("closes the autocomplete list and runs", async () => {
    const view = await viewWithOpenCompletion()
    expect(completionStatus(view.state)).toBe("active")
    let ran = 0
    expect(runAndCloseCompletion(view, () => { ran++ })).toBe(true)
    expect(ran).toBe(1)
    expect(completionStatus(view.state)).toBeNull()
    view.destroy()
  })
})
