// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConnectModal } from "../src/components/ConnectModal.js"

/**
 * The Connect panel's MCP tab, which describes something that has not shipped.
 *
 * `McpContent` in ConnectModal.tsx carries the history; the short version is that this tab used to
 * hand out a copyable config block for a package that was never published. So the assertions here
 * are about absence: a snippet in this tab is the bug, which makes "there is no snippet" the thing
 * worth holding still.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** The panel portals out of the container, so every query runs against the document. */
function openPanel(): void {
  act(() => {
    root.render(<ConnectModal open onClose={() => undefined} />)
  })
}

function tab(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    b => b.textContent?.includes(label),
  )
  if (!found) throw new Error(`no tab button labelled ${label}`)
  return found as HTMLButtonElement
}

describe("the Connect panel's MCP tab", () => {
  it("marks itself as not shipped, from the unselected state", () => {
    // The badge has to be readable before the click. A tab that looks like the other two, and
    // only admits it is empty once opened, has already wasted the reader's time.
    openPanel()
    expect(tab("MCP").textContent).toContain("Soon")
  })

  it("hands out no command, config or package name to copy", () => {
    openPanel()
    act(() => tab("MCP").click())

    const panel = document.body.textContent ?? ""
    expect(panel).toContain("Not available yet")
    expect(panel).not.toContain("@supatype/mcp")
    expect(panel).not.toContain("npx")
    expect(panel).not.toContain("mcpServers")
    expect(panel).not.toContain("SUPATYPE_SERVICE_KEY")
  })

  it("fades the Recommended badge out when you are on another tab, and leaves Soon legible", () => {
    // The two badges share a slot and differ only in this: Recommended is reassurance for the tab
    // you are already on, Soon is a warning you need before you click. Asserted together because
    // they are one table entry apart, and a refactor that collapses them would pass either alone.
    openPanel()
    act(() => tab("MCP").click())

    expect(tab("SDK").querySelector(".opacity-0")).not.toBeNull()
    expect(tab("MCP").querySelector(".opacity-0")).toBeNull()
  })

  it("renders no code block in that tab, where the other two do", () => {
    openPanel()
    act(() => tab("Direct").click())
    expect(document.body.querySelector("pre")).not.toBeNull()

    act(() => tab("MCP").click())
    expect(document.body.querySelector("pre")).toBeNull()
  })
})
