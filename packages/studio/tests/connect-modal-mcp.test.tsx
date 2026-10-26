// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConnectModal } from "../src/components/ConnectModal.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { testClient } from "./support.js"

/**
 * The Connect panel's MCP tab, which describes something that has not shipped.
 *
 * `McpContent` in ConnectModal.tsx carries the history; the short version is that this tab used to
 * hand out a copyable config block for a package that was never published. So the assertions here
 * are about absence: a snippet in this tab is the bug, which makes "there is no snippet" the thing
 * worth holding still.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // The Direct tab asks the server for the connection details; this suite is not about them.
  vi.stubGlobal("fetch", async () => Response.json({ direct: null, pooler: null }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** The panel portals out of the container, so every query runs against the document. */
function openPanel(): void {
  act(() => {
    root.render(
      <AdminClientContext.Provider value={CLIENT}>
        <ConnectModal open onClose={() => undefined} />
      </AdminClientContext.Provider>,
    )
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

  it("renders no code block in that tab, where the SDK tab does", () => {
    // The Direct tab's strings come from the server and are covered in
    // database-connection-strings.test.tsx, so the SDK tab is the one holding a block here.
    openPanel()
    expect(document.body.querySelector("pre")).not.toBeNull()

    act(() => tab("MCP").click())
    expect(document.body.querySelector("pre")).toBeNull()
  })
})
