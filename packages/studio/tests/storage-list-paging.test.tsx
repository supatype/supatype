// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { StorageBrowser } from "../src/views/StorageBrowser.js"
import { MediaLibrary } from "../src/views/MediaLibrary.js"
import { ImageWidget } from "../src/widgets/ImageWidget.js"
import { testClient, testConfig, testField } from "./support.js"

/**
 * Studio's file views read a folder a page at a time and load more on request. They read one page
 * (the storage server's default of 100, or a fixed 100) and stopped, so in a bigger folder the rest
 * of the files were neither listed nor found.
 *
 * The stub answers like packages/storage's list route: `limit` (100 when absent) and `offset`.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", serviceRoleKey: "service" })
const OBJECTS = Array.from({ length: 150 }, (_, i) => ({
  id: `o${i + 1}`,
  bucket_id: "docs",
  name: `file-${String(i + 1).padStart(3, "0")}.txt`,
  owner: null,
  metadata: { size: 1, mimetype: "text/plain" },
  created_at: "2026-10-19T10:00:00Z",
  updated_at: "2026-10-19T10:00:00Z",
  last_accessed_at: "2026-10-19T10:00:00Z",
  size: 1,
  mimetype: "text/plain",
}))
/** Images for the picker: more than the 200 it used to read. */
const IMAGES = Array.from({ length: 250 }, (_, i) => ({ ...OBJECTS[0]!, id: `i${i + 1}`, bucket_id: "images", name: `img-${String(i + 1).padStart(3, "0")}.png` }))
const BUCKET = { id: "docs", name: "docs", public: false, file_size_limit: null, allowed_mime_types: null, created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" }

let root: Root | null = null
let container: HTMLElement
let offsets: number[] = []
let searches: string[] = []

async function answer(url: string, init?: RequestInit): Promise<Response> {
  if (url.endsWith("/storage/v1/bucket")) return Response.json([BUCKET])
  const listed = url.includes("/storage/v1/object/list/docs") ? OBJECTS : url.includes("/storage/v1/object/list/images") ? IMAGES : null
  if (listed !== null) {
    const body: unknown = JSON.parse(String(init?.body ?? "{}"))
    const at = typeof body === "object" && body !== null ? body : {}
    const offset = "offset" in at && typeof at.offset === "number" ? at.offset : 0
    const limit = "limit" in at && typeof at.limit === "number" ? at.limit : 100
    const search = "search" in at && typeof at.search === "string" ? at.search : ""
    offsets.push(offset)
    searches.push(search)
    const matching = listed.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    return Response.json(matching.slice(offset, offset + limit), { headers: { "X-Total-Count": String(matching.length) } })
  }
  return Response.json([])
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function mount(ui: React.ReactElement, at: string): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  offsets = []
  searches = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => answer(url, init))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <AdminConfigContext.Provider value={testConfig()}>
          <AdminClientContext.Provider value={CLIENT}>
            <Routes>
              <Route path="/media-storage/:bucket/files" element={ui} />
              <Route path="/media" element={ui} />
            </Routes>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

function shown(): number {
  return new Set(container.textContent?.match(/file-\d{3}\.txt/g) ?? []).size
}

async function loadMore(): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Load more")
  if (!button) throw new Error("no Load more button")
  await act(async () => button.click())
  await settle()
}

/** Types into the view's search box and waits past its debounce. */
async function search(text: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>("input[type=search], input[placeholder^='Search']")
  if (!input) throw new Error("no search box")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
  await settle()
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

function images(): number {
  return new Set(Array.from(document.body.querySelectorAll("img")).map((i) => i.getAttribute("alt") ?? "").filter((a) => a.startsWith("img-"))).size
}

// The search box asks the server, so it finds files past the ones loaded, and the view says how
// many match. It filtered only the loaded page in the browser.
describe("searching a folder", () => {
  it("asks the server in the storage browser and shows the total", async () => {
    await mount(<StorageBrowser />, "/media-storage/docs/files")
    expect(container.textContent).toContain("100 of 150")
    await search("FILE-14")
    expect(searches.at(-1)).toBe("FILE-14")
    expect(shown()).toBe(10)
    expect(container.textContent).toContain("10 of 10")
  })

  it("asks the server in the media library and shows the total", async () => {
    await mount(<MediaLibrary />, "/media")
    const select = container.querySelector<HTMLSelectElement>("select")
    await act(async () => {
      if (select) select.value = "docs"
      select?.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await settle()
    expect(container.textContent).toContain("100 of 150")
    await search("file-149")
    expect(searches.at(-1)).toBe("file-149")
    expect(shown()).toBe(1)
  })

  it("asks the server in the image picker and shows the total", async () => {
    const field = testField({ name: "cover", widget: "image", options: { bucket: "images" } })
    await mount(<ImageWidget config={field} value={null} onChange={() => undefined} readOnly={false} />, "/media")
    await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select from bucket")?.click())
    await settle()
    expect(document.body.textContent).toContain("100 of 250")
    await search("img-250")
    expect(searches.at(-1)).toBe("img-250")
    expect(images()).toBe(1)
  })
})

describe("a folder with more files than one page", () => {
  it("lists the rest in the image picker on request", async () => {
    const field = testField({ name: "cover", widget: "image", options: { bucket: "images" } })
    await mount(<ImageWidget config={field} value={null} onChange={() => undefined} readOnly={false} />, "/media")
    const open = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select from bucket")
    await act(async () => open?.click())
    await settle()
    expect(images()).toBeLessThan(250)
    const more = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Load more")
    if (!more) throw new Error("no Load more button")
    await act(async () => more.click())
    await settle()
    await act(async () => Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Load more")?.click())
    await settle()
    expect(images()).toBe(250)
  })

  it("lists the rest in the storage browser on request", async () => {
    await mount(<StorageBrowser />, "/media-storage/docs/files")
    expect(shown()).toBe(100)
    await loadMore()
    expect(offsets.at(-1)).toBe(100)
    expect(shown()).toBe(150)
  })

  it("lists the rest in the media library on request", async () => {
    await mount(<MediaLibrary />, "/media")
    const select = container.querySelector<HTMLSelectElement>("select")
    if (select) {
      await act(async () => {
        select.value = "docs"
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      await settle()
    }
    expect(shown()).toBe(100)
    await loadMore()
    expect(offsets.at(-1)).toBe(100)
    expect(shown()).toBe(150)
  })
})
