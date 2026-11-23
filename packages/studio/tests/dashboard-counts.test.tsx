// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { AuthBlock, StatsBlock } from "../src/views/Dashboard.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * Dashboard cards show a count the server gave, or a dash. Behind Cloud's proxy a HEAD answered
 * without a Content-Range, so "Total blog posts" read 0 beside seven rows; a failed user list read 0
 * as well. The weekly sign-ups figure is hidden when the sign-ups function does not answer.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })
const POST = testModel({ name: "Post", label: "Post", labelPlural: "Posts", tableName: "post", fields: [testField({ name: "title" })] })
const BLOCK = { id: "b", type: "stats" as const, title: "Total Posts", visible: true, model: "post" }

let root: Root | null = null
let container: HTMLElement

async function mount(node: React.ReactElement): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <AdminConfigContext.Provider value={testConfig({ models: [POST] })}>
        <AdminClientContext.Provider value={CLIENT}>{node}</AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
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

describe("the Dashboard's row counts", () => {
  it("counts from a one-row GET when the proxy drops Content-Range from HEAD", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 200 })
        : new Response("[]", { status: 206, headers: { "Content-Range": "0-0/7" } }))
    await mount(<StatsBlock block={BLOCK} />)
    expect(container.textContent).toContain("7")
  })

  it("shows a dash, not 0, when no response says how many", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200 }))
    await mount(<StatsBlock block={BLOCK} />)
    expect(container.textContent).toContain("-")
    expect(container.textContent).not.toMatch(/\b0\b/)
  })
})

describe("the Dashboard's Total Users when the list fails", () => {
  it("shows a dash and no weekly figure", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }))
    await mount(<AuthBlock />)
    expect(container.textContent).toContain("-")
    expect(container.textContent).not.toMatch(/\b0\b|this week/)
  })
})
