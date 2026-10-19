// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Clients } from "../src/views/realtime/Clients.js"
import type { InspectorApi } from "../src/views/realtime/InspectorTab.js"

/**
 * The Clients tab pages through every connection with realtime's cursor. It read the first 100
 * and ignored `next`, so with more connected the count said so but the rest were never listed.
 *
 * The stub answers like realtime's admin API (packages/realtime/src/channels.ts listConnections):
 * oldest first, `limit` at a time after the id `after`, with `next` while more remain.
 */

const CONNECTIONS = Array.from({ length: 150 }, (_, i) => ({
  id: String(i + 1),
  userId: `user-${i + 1}`,
  role: "authenticated",
  connectedAt: "2026-10-19T10:00:00Z",
  lastMessageAt: null,
  channels: ["room"],
  client: null,
  userAgent: null,
}))

let root: Root | null = null
let container: HTMLElement
let paths: string[] = []

function answer(path: string): Response {
  const url = new URL(path, "http://x/")
  const limit = Number(url.searchParams.get("limit") ?? "100")
  const after = Number(url.searchParams.get("after") ?? "0")
  const remaining = CONNECTIONS.filter((c) => Number(c.id) > after)
  const page = remaining.slice(0, limit)
  const next = remaining.length > page.length ? page.at(-1)!.id : null
  return Response.json({ data: { total: CONNECTIONS.length, limit: null, tier: null, connections: page, next } })
}

const api: InspectorApi = {
  mode: "self-host",
  fetch: async (path: string) => {
    paths.push(path)
    return answer(path)
  },
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function users(): string[] {
  return Array.from(container.querySelectorAll("tbody tr td:first-child")).map((td) => td.textContent ?? "")
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
})

describe("the Clients tab", () => {
  it("pages to the connections after the first 100", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    paths = []
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<Clients api={api} />))
    await settle()
    expect(users()).toHaveLength(100)
    expect(container.textContent).toContain("Page 1 of 2 (150)")
    const next = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Next")
    await act(async () => next?.click())
    await settle()
    expect(paths.at(-1)).toContain("after=100")
    expect(users()).toHaveLength(50)
    expect(users()).toContain("user-150")
  })
})
