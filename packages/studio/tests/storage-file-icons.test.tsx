// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { StorageBrowser } from "../src/views/StorageBrowser.js"
import { testClient, testConfig } from "./support.js"

/**
 * A bucket's entries say what they are with an icon, not a bracketed word.
 *
 * A folder read "[dir] photos" and a file "[pdf] report.pdf": the prefix was a placeholder for an
 * icon that never arrived. Each entry now carries the shared icon for its kind, named in a tooltip
 * so the meaning is there for anyone who does not read the picture.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const BUCKET = { id: "docs", name: "docs", public: false, file_size_limit: null, allowed_mime_types: null, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" }
const AT = "2026-10-19T10:00:00Z"
const ENTRIES = [
  { id: null, bucket_id: "docs", name: "mt18-folder", owner: null, created_at: null, updated_at: null, last_accessed_at: null, metadata: null, size: null, mimetype: null },
  { id: "id-report", bucket_id: "docs", name: "report.pdf", owner: null, created_at: AT, updated_at: AT, last_accessed_at: AT, metadata: { size: 10, mimetype: "application/pdf" }, size: 10, mimetype: "application/pdf" },
  { id: "id-notes", bucket_id: "docs", name: "notes.bin", owner: null, created_at: AT, updated_at: AT, last_accessed_at: AT, metadata: { size: 10, mimetype: "application/octet-stream" }, size: 10, mimetype: "application/octet-stream" },
]

let root: Root | null = null
let container: HTMLElement

function answer(url: string): Response {
  if (url.endsWith("/storage/v1/bucket")) return Response.json([BUCKET])
  if (url.includes("/storage/v1/object/list/")) return Response.json(ENTRIES)
  return Response.json([])
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function mount(): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", (url: string) => Promise.resolve(answer(url)))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/media-storage/docs/files"]}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <Routes>
              <Route path="/media-storage/:bucket/files" element={<StorageBrowser />} />
            </Routes>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

/** The tooltip of each icon drawn in the browser, in order. */
function iconTitles(): string[] {
  return Array.from(container.querySelectorAll("[role=img]")).map((icon) => icon.getAttribute("title") ?? "")
}

async function showGrid(): Promise<void> {
  const grid = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Grid")
  if (!grid) throw new Error("no Grid button")
  await act(async () => grid.click())
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("storage entry icons", () => {
  it("draws a folder icon with a tooltip in the list, and no text prefix", async () => {
    await mount()
    expect(container.textContent).not.toMatch(/\[(dir|pdf|file)\]/)
    expect(iconTitles()).toEqual(["Folder", "PDF", "File"])
  })

  it("draws the same icons in the grid", async () => {
    await mount()
    await showGrid()
    expect(container.textContent).not.toMatch(/\[dir\]|\bPDF\b|\bFILE\b/)
    expect(iconTitles()).toEqual(["Folder", "PDF", "File"])
  })
})
