// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConnectModal } from "../src/components/ConnectModal.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { testClient } from "./support.js"

/**
 * The Connect panel showed `createClient<Database>` from `@supatype/client`. That client does not
 * know which models keep drafts, so `update(..., { publish: true })` stopped compiling and RPC
 * names typed as never. It now shows the `createClient` the CLI generates, as the client guide does.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
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

function openPanel(): void {
  act(() => {
    root.render(
      <AdminClientContext.Provider value={CLIENT}>
        <ConnectModal open onClose={() => undefined} />
      </AdminClientContext.Provider>,
    )
  })
}

/** Every code block the panel shows, as one string. */
function code(): string {
  return Array.from(document.body.querySelectorAll("pre")).map((pre) => pre.textContent ?? "").join("\n")
}

describe("the Connect panel's client file", () => {
  it("imports the generated createClient, not the untyped one", () => {
    openPanel()
    expect(code()).toContain("import { createClient } from '../supatype/generated/client'")
    expect(code()).not.toContain("createClient<Database>")
    expect(code()).not.toContain("import { createClient } from '@supatype/client'")
  })
})
