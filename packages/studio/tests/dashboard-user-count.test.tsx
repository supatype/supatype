// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AuthBlock } from "../src/views/Dashboard.js"
import { testClient } from "./support.js"

/**
 * The Dashboard's Total Users is the server's count, not the length of the first page. It counted
 * the users on page one, so it never showed more than 50, and its "this week" figure asked for a
 * `created_after` parameter the auth server does not have, so it repeated the same capped number.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const USERS = Array.from({ length: 62 }, (_, i) => ({ id: `u${i}`, email: `user${i}@example.com` }))

let root: Root | null = null
let container: HTMLElement

function stubFetch(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw)
    if (url.pathname.endsWith("/auth/v1/admin/users")) {
      const perPage = Number(url.searchParams.get("per_page") ?? "50")
      return Response.json({ users: USERS.slice(0, perPage), aud: "authenticated" }, { headers: { "X-Total-Count": "62" } })
    }
    if (url.pathname.endsWith("/rest/v1/rpc/daily_signups")) {
      return Response.json([{ day: "2026-10-18", count: 3 }, { day: "2026-10-19", count: 4 }])
    }
    return Response.json({})
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the Dashboard's Total Users", () => {
  it("shows the server's count and the week's sign-ups", async () => {
    stubFetch()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <AdminClientContext.Provider value={CLIENT}>
          <AuthBlock />
        </AdminClientContext.Provider>,
      )
    })
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain("62")
    expect(container.textContent).toContain("+7 this week")
  })
})
