// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { DbSizeBlock, StorageBlock } from "../src/views/Dashboard.js"
import { SizeSourceCtx, megabytesToFigure, type SizeSource } from "../src/lib/size-source.js"
import { testClient } from "./support.js"

/**
 * The Database Size and Storage cards read their figures from a source the host gives Studio.
 * Cloud does not expose the `supatype` schema, so its source reads the platform's metered usage and
 * the cards show used of limit. With no source the project's own functions are read, as on self-host.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

let root: Root | null = null
let container: HTMLElement
let requests: string[] = []

async function mount(source: SizeSource | undefined): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <SizeSourceCtx.Provider value={source}>
        <AdminClientContext.Provider value={CLIENT}>
          <DbSizeBlock />
          <StorageBlock />
        </AdminClientContext.Provider>
      </SizeSourceCtx.Provider>,
    )
  })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the Dashboard's size cards", () => {
  it("show used of limit from the host's source and read no function", async () => {
    requests = []
    vi.stubGlobal("fetch", async (url: string) => { requests.push(String(url)); return Response.json([]) })
    await mount({
      read: async () => ({ db: megabytesToFigure(12, 500), storage: megabytesToFigure(3, 1024), fileCount: null }),
    })
    expect(container.textContent).toContain("12.0 MB of 500.0 MB")
    expect(container.textContent).toContain("3.0 MB of 1.00 GB")
    expect(requests.filter((r) => r.includes("/rpc/"))).toEqual([])
  })

  it("read db_stats and storage_stats when the host gives no source", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).endsWith("/rpc/db_stats")
        ? Response.json([{ db_size_bytes: 2097152, db_size_pretty: "2 MB" }])
        : Response.json([{ file_count: 4, total_bytes: 1048576 }]))
    await mount(undefined)
    expect(container.textContent).toContain("2.0 MB")
    expect(container.textContent).toContain("1.0 MB")
    expect(container.textContent).toContain("4 files")
  })

  it("show a dash when the source cannot say", async () => {
    await mount({ read: async () => ({ db: null, storage: null, fileCount: null }) })
    expect(container.textContent).not.toContain("…")
    expect(container.textContent).toMatch(/Database Size-/)
  })
})
