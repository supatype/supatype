// @vitest-environment jsdom
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { BlocksWidget } from "../src/widgets/BlocksWidget.js"
import { act, isolateEachTest, mount, testField } from "./support.js"

/**
 * A block's header names its type with the schema's icon and label, and its actions are icon
 * buttons with names a screen reader says. It used to print the icon's name as text ("megaphone
 * Hero") and label the actions "D" and "X", and the block count floated beside the first block,
 * squeezing it narrower than the rest.
 */

isolateEachTest()

const BLOCK_TYPES = [
  { name: "hero", label: "Hero", icon: "megaphone", fields: [] },
  { name: "prose", label: "Prose", icon: "text", fields: [] },
  { name: "speakers", label: "Speaker grid", icon: "users", fields: [] },
]

async function renderBlocks(onChange: (value: unknown) => void = () => {}): Promise<HTMLElement> {
  const config = testField({
    name: "body",
    widget: "blocks",
    options: { blockTypes: BLOCK_TYPES },
    validation: { maxItems: 20 },
  })
  const value = [{ type: "hero", data: {} }, { type: "prose", data: {} }, { type: "speakers", data: {} }]
  return (await mount(<BlocksWidget config={config} value={value} onChange={onChange} readOnly={false} />)).container
}

function headers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-block-header]"))
}

describe("BlocksWidget", () => {
  it("draws each block type's icon and shows only its label as text", async () => {
    const rows = headers(await renderBlocks())
    expect(rows.map((row) => row.querySelector("[data-block-type]")?.textContent)).toEqual(["Hero", "Prose", "Speaker grid"])
    for (const row of rows) expect(row.querySelector("[data-block-type] svg")).not.toBeNull()
  })

  it("names every action for a screen reader and shows no letters for them", async () => {
    const [first] = headers(await renderBlocks())
    if (!first) throw new Error("no block rendered")
    // Five buttons: the block's own (its type, which opens it) and the four icon-only actions.
    const [toggle, ...actions] = Array.from(first.querySelectorAll("button"))
    expect(toggle?.textContent).toBe("Hero")
    expect(actions.map((b) => b.getAttribute("aria-label"))).toEqual(["Move Hero up", "Move Hero down", "Duplicate Hero", "Delete Hero"])
    for (const b of actions) expect(b.textContent?.trim()).toBe("")
  })

  // The header was a clickable row with no button, so a block could not be opened from the keyboard.
  it("opens a block from a disclosure button, which Enter and Space reach", async () => {
    const [first] = headers(await renderBlocks())
    const toggle = first?.querySelector<HTMLButtonElement>('[data-ui="disclosure-button"]')
    if (!toggle) throw new Error("no disclosure button")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    await act(() => { toggle.click() })
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
  })

  it("puts the block count on the row with Add block, not beside the first block", async () => {
    const container = await renderBlocks()
    const count = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "3 blocks (at most 20)")
    if (!count) throw new Error("no block count")
    const addRow = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Add block"))?.parentElement
    expect(addRow?.contains(count)).toBe(true)
  })

  it("duplicates a block with its named button", async () => {
    const onChange = vi.fn()
    const [first] = headers(await renderBlocks(onChange))
    const duplicate = first?.querySelector<HTMLButtonElement>('button[aria-label="Duplicate Hero"]')
    if (!duplicate) throw new Error("no duplicate button")
    await act(() => { duplicate.click() })
    const next: unknown = onChange.mock.calls[0]?.[0]
    const types = Array.isArray(next) ? next.map((b: unknown) => (typeof b === "object" && b !== null && "type" in b ? b.type : null)) : null
    expect(types).toEqual(["hero", "hero", "prose", "speakers"])
  })
})
