// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RestCacheBrowser } from "../src/views/RestCacheBrowser.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { testClient, testConfig } from "./support.js"

/**
 * The REST cache list pages through the server's scan cursor and can page back. Its "Load more"
 * replaced the entries on screen with the next page, with no way back to the first, and kept the
 * cursor of one table's scan when the table changed, so the new table's list started mid-scan.
 */

const client = testClient({ url: "http://localhost:8000/studio/proxy" })
const entry = (key: string) => ({ key, table: "posts", scope: "public", path: `/rest/v1/${key}`, ttl_seconds: 60, size_bytes: 10 })

let container: HTMLDivElement
let root: Root
let cursors: string[] = []

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  cursors = []
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    if (!raw.includes("/admin/v1/cache?")) return new Response(null, { status: 404 })
    const cursor = new URL(raw).searchParams.get("cursor") ?? "0"
    cursors.push(cursor)
    return cursor === "0"
      ? Response.json({ entries: [entry("first")], cursor: "7" })
      : Response.json({ entries: [entry("second")], cursor: "0" })
  }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(table: string): Promise<void> {
  await act(async () => {
    root.render(
      <AdminClientContext.Provider value={client}>
        <AdminConfigContext.Provider value={testConfig()}>
          <RestCacheBrowser tableFilter={table} />
        </AdminConfigContext.Provider>
      </AdminClientContext.Provider>,
    )
  })
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function click(...labels: string[]): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find((b) => labels.includes(b.textContent ?? ""))
  const label = labels.join(" or ")
  if (!button) throw new Error(`no ${label} button`)
  await act(async () => button.click())
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe("the REST cache list", () => {
  it("pages forward with the scan cursor and back to the first page", async () => {
    await render("posts")
    expect(container.textContent).toContain("/rest/v1/first")
    await click("Next")
    expect(cursors.at(-1)).toBe("7")
    expect(container.textContent).toContain("/rest/v1/second")
    await click("Previous")
    expect(cursors.at(-1)).toBe("0")
    expect(container.textContent).toContain("/rest/v1/first")
  })

  it("starts a new table's list from the beginning", async () => {
    await render("posts")
    // "Load more" is the old control, so this fails on the old code for the reason it names.
    await click("Next", "Load more")
    expect(cursors.at(-1)).toBe("7")
    await render("comments")
    expect(cursors.at(-1)).toBe("0")
  })
})
