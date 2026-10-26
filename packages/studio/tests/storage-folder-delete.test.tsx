// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { isJsonObject } from "../src/lib/json.js"
import { StorageBrowser } from "../src/views/StorageBrowser.js"
import { testClient, testConfig } from "./support.js"

/**
 * N2 (final15): deleting a folder removes every object under it, its empty placeholder included,
 * and says so when some of them stay.
 *
 * The delete sent the folder's own name, and both storage servers delete objects by exact name, so
 * nothing matched, nothing was removed, and the answer was an empty list that Studio took for done.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const BUCKET = { id: "pics", name: "pics", public: false, file_size_limit: null, allowed_mime_types: null, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" }

/** The bucket's objects by full name, and the names the server refuses to delete. */
let objects = new Set<string>()
let protectedNames = new Set<string>()
let root: Root | null = null
let container: HTMLElement

function fileEntry(name: string): Record<string, unknown> {
  const at = "2026-10-19T10:00:00Z"
  return { id: `id-${name}`, bucket_id: "pics", name, owner: null, created_at: at, updated_at: at, last_accessed_at: at, metadata: { size: 1, mimetype: "image/png" }, size: 1, mimetype: "image/png" }
}

function folderEntry(name: string): Record<string, unknown> {
  return { id: null, bucket_id: "pics", name, owner: null, created_at: null, updated_at: null, last_accessed_at: null, metadata: null, size: null, mimetype: null }
}

/** A folder's direct children, as both servers answer a list: folders first, then files. */
function listFolder(prefix: string, limit: number, offset: number): Record<string, unknown>[] {
  const folder = prefix === "" ? "" : `${prefix.replace(/\/+$/, "")}/`
  const folders = new Set<string>()
  const files: string[] = []
  for (const name of [...objects].sort()) {
    if (!name.startsWith(folder)) continue
    const rest = name.slice(folder.length)
    const slash = rest.indexOf("/")
    if (slash >= 0) folders.add(rest.slice(0, slash))
    else files.push(rest)
  }
  const entries = [...[...folders].map(folderEntry), ...files.map(fileEntry)]
  return entries.slice(offset, offset + limit)
}

function body(init?: RequestInit): Record<string, unknown> {
  const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {}
  return isJsonObject(parsed) ? parsed : {}
}

/** Deletes by exact name, as both servers do, and answers only what it removed. */
function remove(init?: RequestInit): Response {
  const names = body(init)["prefixes"]
  const removed = (Array.isArray(names) ? names : []).filter((n): n is string => typeof n === "string" && objects.has(n) && !protectedNames.has(n))
  for (const name of removed) objects.delete(name)
  return Response.json(removed.map((name) => ({ name, bucket_id: "pics" })))
}

async function answer(url: string, init?: RequestInit): Promise<Response> {
  if (url.endsWith("/storage/v1/bucket")) return Response.json([BUCKET])
  if (url.includes("/storage/v1/object/list/")) {
    const b = body(init)
    const prefix = typeof b["prefix"] === "string" ? b["prefix"] : ""
    const limit = typeof b["limit"] === "number" ? b["limit"] : 100
    const offset = typeof b["offset"] === "number" ? b["offset"] : 0
    return Response.json(listFolder(prefix, limit, offset))
  }
  if (init?.method === "DELETE" && url.endsWith("/storage/v1/object/pics")) return remove(init)
  return Response.json([])
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function mount(): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => answer(url, init))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/media-storage/pics/files"]}>
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

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text)
  if (!found) throw new Error(`no ${text} button`)
  return found
}

/** Ticks the row named `name` and deletes the selection through the confirmation. */
async function deleteRow(name: string): Promise<void> {
  const row = Array.from(container.querySelectorAll("tr")).find((tr) => tr.querySelector("td button")?.textContent === `[dir] ${name}`)
  const tick = row?.querySelector<HTMLInputElement>("input[type=checkbox]")
  if (!tick) throw new Error(`no row for ${name}`)
  await act(async () => tick.click())
  await act(async () => button("Delete 1 selected").click())
  // The confirmation is drawn last, after the rows and their own Delete buttons.
  const confirm = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Delete").pop()
  if (!confirm) throw new Error("no confirmation")
  await act(async () => confirm.click())
  await settle()
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("deleting a folder", () => {
  it("removes an empty folder's placeholder, so the folder goes", async () => {
    objects = new Set(["mt16-folder/.emptyFolderPlaceholder", "keep.png"])
    protectedNames = new Set()
    await mount()
    await deleteRow("mt16-folder")
    expect([...objects]).toEqual(["keep.png"])
    expect(container.textContent).not.toContain("mt16-folder")
  })

  it("removes every object anywhere under the folder, and nothing beside it", async () => {
    objects = new Set(["mt16/a.png", "mt16/deep/b.png", "mt16/deep/deeper/.emptyFolderPlaceholder", "mt16-other/c.png"])
    protectedNames = new Set()
    await mount()
    await deleteRow("mt16")
    expect([...objects]).toEqual(["mt16-other/c.png"])
  })

  it("says how many objects stayed when the server keeps some", async () => {
    objects = new Set(["mt16/a.png", "mt16/b.png"])
    protectedNames = new Set(["mt16/b.png"])
    await mount()
    await deleteRow("mt16")
    expect([...objects]).toEqual(["mt16/b.png"])
    expect(container.textContent).toContain("1 of 2 objects could not be deleted")
  })
})
