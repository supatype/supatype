// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { AuthManagement } from "../src/views/AuthManagement.js"
import { act, advance, button, isolateEachTest, mount, testClient } from "./support.js"

/**
 * The Users list reads one page of the auth admin API at a time and searches on the server. It used
 * to fetch the first 50 users and filter those in the browser, so on a project with more users the
 * rest could neither be seen nor found.
 *
 * The stub answers the way the auth server does (internal/auth/admin.go adminUsers): `page` is one
 * based, `per_page` defaults to 50, `filter` matches email or full name, and X-Total-Count carries
 * how many users match in all.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const USERS = Array.from({ length: 62 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  email: `user${i + 1}@example.com`,
  created_at: "2026-10-01T10:00:00Z",
  app_metadata: {},
  user_metadata: {},
  identities: [],
}))
const LATE = USERS[59]!

/** The Users list on screen, and every list request it has sent. */
interface UsersList {
  container: HTMLElement
  calls: URL[]
}

/** The first three users, banned: what the server answers to `banned=true`. */
const BANNED = USERS.slice(0, 3).map((u) => ({ ...u, banned_until: "2126-01-01T00:00:00Z" }))

function userPage(url: URL): Response {
  const page = Number(url.searchParams.get("page") ?? "1")
  const perPage = Number(url.searchParams.get("per_page") ?? "50")
  const filter = url.searchParams.get("filter") ?? ""
  const pool = url.searchParams.get("banned") === "true" ? BANNED : USERS
  const matching = pool.filter((u) => u.email.includes(filter))
  const users = matching.slice((page - 1) * perPage, page * perPage)
  return Response.json({ users, aud: "authenticated" }, { headers: { "X-Total-Count": String(matching.length) } })
}

function stubFetch(calls: URL[]): void {
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw)
    if (url.pathname.endsWith("/auth/v1/admin/users")) {
      calls.push(url)
      return userPage(url)
    }
    const byId = /\/auth\/v1\/admin\/users\/([^/]+)$/.exec(url.pathname)
    if (byId) {
      const user = USERS.find((u) => u.id === byId[1])
      return user ? Response.json(user) : Response.json({ msg: "User not found" }, { status: 404 })
    }
    if (url.pathname.endsWith("/auth/v1/admin/sessions")) return Response.json({ sessions: [] })
    return Response.json({ rows: [], members: [], roles: [] })
  })
}

async function renderUsers(): Promise<UsersList> {
  const calls: URL[] = []
  stubFetch(calls)
  const { container } = await mount(
    <MemoryRouter initialEntries={["/auth/users"]}>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={CLIENT}>
          <AuthManagement />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await advance()
  return { container, calls }
}

function searchBox(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("input[placeholder^='Search']")
  if (!input) throw new Error("no search box rendered")
  return input
}

async function search(container: HTMLElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(() => {
    setter?.call(searchBox(container), value)
    searchBox(container).dispatchEvent(new Event("input", { bubbles: true }))
  })
  // Past the search box's 300ms debounce on the virtual clock, then let the request land.
  await advance(150)
}

function rowEmails(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tbody tr td:first-child")).map((td) => td.textContent ?? "")
}

/** Picks `value` in the select that offers it. */
async function choose(container: HTMLElement, value: string): Promise<void> {
  const select = Array.from(container.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === value))
  if (!select) throw new Error(`no select offering ${value}`)
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await advance()
}

/** The role, status and provider parameters of the last list request. */
function lastFilters(calls: readonly URL[]): Record<string, string | null> {
  const last = calls.at(-1)
  return Object.fromEntries(["role", "banned", "confirmed", "provider", "page"].map((k) => [k, last?.searchParams.get(k) ?? null]))
}

isolateEachTest()

describe("the Users list", () => {
  it("sends the search text to the server as `filter`", async () => {
    const { container, calls } = await renderUsers()
    await search(container, "user60@")
    const last = calls.at(-1)
    expect(last?.searchParams.get("filter")).toBe("user60@")
    expect(last?.searchParams.get("page")).toBe("1")
  })

  it("finds a user beyond the first 50", async () => {
    const { container } = await renderUsers()
    expect(rowEmails(container)).not.toContain(LATE.email)
    await search(container, LATE.email)
    expect(rowEmails(container)).toEqual([LATE.email])
  })

  it("returns to the full list when the search is cleared", async () => {
    const { container, calls } = await renderUsers()
    await search(container, "user60@")
    await search(container, "")
    expect(calls.at(-1)?.searchParams.has("filter")).toBe(false)
    expect(rowEmails(container)).toHaveLength(50)
  })

  it("pages to the users after the first 50", async () => {
    const { container, calls } = await renderUsers()
    expect(container.textContent).toContain("Page 1 of 2 (62)")
    await act(() => button(container, "Next").click())
    await advance()
    expect(calls.at(-1)?.searchParams.get("page")).toBe("2")
    expect(rowEmails(container)).toHaveLength(12)
    expect(rowEmails(container)).toContain(LATE.email)
    expect(container.textContent).toContain("Page 2 of 2 (62)")
  })

  // The role, status and provider filters used to apply only to the page on screen.
  it("filters by status on the server, across every user", async () => {
    const { container, calls } = await renderUsers()
    await choose(container, "disabled")
    expect(lastFilters(calls)).toMatchObject({ banned: "true", confirmed: null, page: "1" })
    expect(rowEmails(container)).toHaveLength(3)
    expect(container.textContent).toContain("Users 1-3 of 3")
    await choose(container, "active")
    expect(lastFilters(calls)).toMatchObject({ banned: "false", confirmed: "true" })
    await choose(container, "unconfirmed")
    expect(lastFilters(calls)).toMatchObject({ banned: null, confirmed: "false" })
  })

  it("filters by role and provider on the server", async () => {
    const { container, calls } = await renderUsers()
    await choose(container, "authenticated")
    expect(lastFilters(calls)).toMatchObject({ role: "authenticated" })
    await choose(container, "github")
    expect(lastFilters(calls)).toMatchObject({ role: "authenticated", provider: "github" })
  })

  it("finds a user by ID, which the server's filter does not search", async () => {
    const { container } = await renderUsers()
    await search(container, LATE.id)
    expect(rowEmails(container)).toEqual([LATE.email])
  })
})
