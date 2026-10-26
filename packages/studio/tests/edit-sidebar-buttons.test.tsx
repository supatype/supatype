// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EditFormSidebar } from "../src/components/EditFormSidebar.js"

/**
 * The edit sidebar's Save, Duplicate and Delete were hand-rolled `st-btn` buttons with their own
 * stylesheet rules, so they drifted from every other button in Studio. They are the shared
 * `Button` now, which marks itself `data-ui="button"`, and still do what they did.
 */

let root: Root | null = null
let container: HTMLElement

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
})

function renderSidebar(handlers: { onSave: () => void; onDuplicate: () => void; onDelete: () => void }, saving = false): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <EditFormSidebar
        metaFields={[]}
        values={{}}
        onChange={() => undefined}
        primaryKey="id"
        currentLocale="en"
        defaultLocale="en"
        recordSyncKey="r1"
        saving={saving}
        {...handlers}
      />,
    )
  })
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no "${label}" button`)
  return found
}

describe("the edit sidebar's actions", () => {
  it("are the shared Button and each calls its handler", () => {
    const handlers = { onSave: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn() }
    renderSidebar(handlers)
    for (const label of ["Save", "Duplicate", "Delete"]) {
      const button = buttonNamed(label)
      expect(button.dataset["ui"], label).toBe("button")
      expect(button.className, label).not.toContain("st-btn")
      act(() => button.click())
    }
    expect(handlers.onSave).toHaveBeenCalledOnce()
    expect(handlers.onDuplicate).toHaveBeenCalledOnce()
    expect(handlers.onDelete).toHaveBeenCalledOnce()
  })

  it("holds Save while a save is in flight", () => {
    renderSidebar({ onSave: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn() }, true)
    expect(buttonNamed("Saving...").disabled).toBe(true)
  })
})
