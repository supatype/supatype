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
 * "New Folder" writes the folder's empty placeholder, and says why when the server refuses it.
 *
 * The refusal was set on the file list behind the dialog, which stayed open and said nothing, so
 * the folder looked made until the dialog was closed.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const BUCKET = { id: "pics", name: "pics", public: false, file_size_limit: null, allowed_mime_types: ["image/png"], created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T10:00:00Z" }
const REFUSAL = "Content type 'application/octet-stream' is not allowed for bucket 'pics'."

let uploads: string[] = []
let refuse = false
let root: Root | null = null
let container: HTMLElement

async function answer(url: string, init?: RequestInit): Promise<Response> {
  if (url.endsWith("/storage/v1/bucket")) return Response.json([BUCKET])
  if (url.includes("/storage/v1/object/list/")) return Response.json([], { headers: { "X-Total-Count": "0" } })
  if (init?.method === "POST" && url.includes("/storage/v1/object/pics/")) {
    uploads.push(new URL(url).pathname)
    return refuse ? Response.json({ error: REFUSAL }, { status: 415 }) : Response.json({ Key: "pics/x" })
  }
  return Response.json([])
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function mount(): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  uploads = []
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

/** Opens the dialog, names the folder and presses Create. */
async function createFolder(name: string): Promise<void> {
  await act(async () => button("New Folder").click())
  const input = container.querySelector<HTMLInputElement>("input[placeholder='Folder name...']")
  if (!input) throw new Error("no folder name box")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, name)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => button("Create").click())
  await settle()
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("New Folder", () => {
  it("writes the folder's empty placeholder and closes", async () => {
    refuse = false
    await mount()
    await createFolder("mt15")
    expect(uploads).toEqual(["/studio/proxy/storage/v1/object/pics/mt15/.emptyFolderPlaceholder"])
    expect(container.textContent).not.toContain("Create Folder")
  })

  it("shows the server's refusal in the dialog, which stays open", async () => {
    refuse = true
    await mount()
    await createFolder("mt15")
    const dialog = Array.from(container.querySelectorAll("h3")).find((h) => h.textContent === "Create Folder")?.parentElement
    expect(dialog?.textContent).toContain(REFUSAL)
  })
})
