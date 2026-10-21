// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import React from "react"
import { Clients } from "../src/views/realtime/Clients.js"
import type { InspectorApi } from "../src/views/realtime/InspectorTab.js"
import { act, advance, button, isolateEachTest, mount } from "./support.js"

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

isolateEachTest()

function answer(path: string): Response {
  const url = new URL(path, "http://x/")
  const limit = Number(url.searchParams.get("limit") ?? "100")
  const after = Number(url.searchParams.get("after") ?? "0")
  const remaining = CONNECTIONS.filter((c) => Number(c.id) > after)
  const page = remaining.slice(0, limit)
  const next = remaining.length > page.length ? page.at(-1)!.id : null
  return Response.json({ data: { total: CONNECTIONS.length, limit: null, tier: null, connections: page, next } })
}

/** An inspector API that answers like realtime's and records every path it is asked for. */
function recordingApi(paths: string[]): InspectorApi {
  return {
    mode: "self-host",
    fetch: async (path: string) => {
      paths.push(path)
      return answer(path)
    },
  }
}

function users(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tbody tr td:first-child")).map((td) => td.textContent ?? "")
}

describe("the Clients tab", () => {
  it("pages to the connections after the first 100", async () => {
    const paths: string[] = []
    const { container } = await mount(<Clients api={recordingApi(paths)} />)
    await advance()
    expect(users(container)).toHaveLength(100)
    expect(container.textContent).toContain("Page 1 of 2 (150)")
    await act(() => button(container, "Next").click())
    await advance()
    expect(paths.at(-1)).toContain("after=100")
    expect(users(container)).toHaveLength(50)
    expect(users(container)).toContain("user-150")
  })
})
