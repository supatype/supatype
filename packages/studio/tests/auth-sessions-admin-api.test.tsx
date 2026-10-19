// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { AuthManagement } from "../src/views/AuthManagement.js"
import { testClient } from "./support.js"

/**
 * The Users view lists active sessions and revokes one through the project's auth admin API, the
 * same API and the same roles as the rest of user administration. It used to read and delete
 * auth.sessions through the SQL editor's route, which is for a different set of roles and cannot
 * touch the tables the auth service owns once the editor is not a superuser.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const USER = { id: "11111111-1111-1111-1111-111111111111", email: "ada@example.com", created_at: "2026-10-01T10:00:00Z", app_metadata: {}, user_metadata: {}, identities: [] }
const SESSION = { id: "22222222-2222-2222-2222-222222222222", user_id: USER.id, ip: "203.0.113.7", user_agent: "test-agent", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T11:00:00Z", not_after: null }

/** Another user's session, which every-session endpoint returns and the user's own does not. */
const OTHER_SESSION = { ...SESSION, id: "33333333-3333-3333-3333-333333333333", user_id: "44444444-4444-4444-4444-444444444444", ip: "198.51.100.9" }

let root: Root | null = null
let container: HTMLElement
let calls: Array<{ url: string; method: string }> = []

function stubFetch(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" })
    if (url.endsWith("/sql")) return Response.json({ error: "forbidden", message: "Your role cannot use the SQL editor" }, { status: 403 })
    if (url.endsWith(`/auth/v1/admin/users/${USER.id}/sessions`)) return Response.json({ sessions: [SESSION] })
    if (url.includes("/auth/v1/admin/users")) return Response.json({ users: [USER], aud: "authenticated" })
    if (url.endsWith("/auth/v1/admin/sessions")) return Response.json({ sessions: [SESSION, OTHER_SESSION] })
    if (url.includes("/auth/v1/admin/sessions/")) return Response.json({})
    return Response.json({ rows: [], members: [], roles: [] })
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function openUser(): Promise<void> {
  stubFetch()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/auth/users?user=${USER.id}`]}>
        <AdminConfigContext.Provider value={mockConfig}>
          <AdminClientContext.Provider value={CLIENT}>
            <AuthManagement />
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>
      </MemoryRouter>,
    )
  })
  await settle()
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the Users view's sessions", () => {
  // Only the open user's sessions, asked for by user. It used to read every active session in the
  // project and filter them in the browser, which grows with every signed-in user.
  it("lists the open user's sessions through the auth admin API, never the SQL editor's route", async () => {
    await openUser()
    expect(calls.filter((c) => c.url.endsWith("/sql"))).toEqual([])
    expect(calls).toContainEqual({ url: `${PROXY}/auth/v1/admin/users/${USER.id}/sessions`, method: "GET" })
    expect(calls.filter((c) => c.url.endsWith("/auth/v1/admin/sessions"))).toEqual([])
    // The user panel renders into a portal, outside the view's container.
    expect(document.body.textContent).toContain("203.0.113.7")
  })

  it("revokes one through the auth admin API", async () => {
    await openUser()
    const revoke = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Revoke")
    expect(revoke, "a Revoke button for the session").toBeDefined()
    await act(async () => revoke!.click())
    await settle()
    expect(calls).toContainEqual({ url: `${PROXY}/auth/v1/admin/sessions/${SESSION.id}`, method: "DELETE" })
    expect(calls.filter((c) => c.url.endsWith("/sql"))).toEqual([])
  })
})
