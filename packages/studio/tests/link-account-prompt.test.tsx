// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { ElevatedNoticeProvider, useShowsProjectRows } from "../src/components/ElevatedModeBanner.js"
import { LinkAccountPrompt } from "../src/components/LinkAccountPrompt.js"
import { elementOf, testClient } from "./support.js"

/**
 * WP14 (RD2, RL2): on Cloud a Studio member acts as their linked project user, and a member with no
 * link is refused data rather than elevated. Studio says so where project rows would be, and links
 * the account by having the member sign in once to the project's own auth: the proxy passes that
 * sign-in through, and the control plane verifies the token it returns and stores the link.
 */

const PROXY = "https://api.example.test/api/v1/projects/abc/proxy"
const CLIENT = testClient({ url: PROXY, token: "platform-token" })

interface Verify {
  mode: "self" | "elevated"
  identityLink?: { linked: boolean }
}

let root: Root | null = null
let container: HTMLElement
let calls: Array<{ url: string; method: string; body: unknown }> = []

function stubFetch(verify: Verify, token = "project-access-token"): void {
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.endsWith("/studio/auth/verify")) return Response.json({ role: "editor", permissions: {}, ...verify })
    if (url.includes("/auth/v1/token")) return Response.json({ access_token: token })
    if (url.endsWith("/studio/identity-link")) return Response.json({ data: { linked: true } })
    return new Response("{}", { status: 404 })
  })
}

function ShowsRows(): null {
  useShowsProjectRows()
  return null
}

async function render(verify: Verify, onLinked = vi.fn()): Promise<typeof onLinked> {
  stubFetch(verify)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <AdminClientContext.Provider value={CLIENT}>
        <ElevatedNoticeProvider>
          <ShowsRows />
          <LinkAccountPrompt onLinked={onLinked} />
        </ElevatedNoticeProvider>
      </AdminClientContext.Provider>,
    )
  })
  return onLinked
}

function field(name: string): HTMLInputElement {
  return elementOf(container, `input[name="${name}"]`, HTMLInputElement)
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.unstubAllGlobals()
})

describe("the link-your-account prompt", () => {
  it("asks an unlinked member acting as themselves to link their account", async () => {
    await render({ mode: "self", identityLink: { linked: false } })
    expect(container.textContent).toContain("Link your account")
    expect(field("email")).not.toBeNull()
    expect(field("password")).not.toBeNull()
  })

  it("says nothing to a linked member, to an elevated admin, or on a host that has no links", async () => {
    for (const verify of [
      { mode: "self", identityLink: { linked: true } },
      { mode: "elevated", identityLink: { linked: false } },
      { mode: "self" },
    ] as Verify[]) {
      await render(verify)
      expect(container.textContent).toBe("")
      act(() => root?.unmount())
    }
  })

  it("signs in to the project's own auth through the proxy, then hands the token to the control plane once", async () => {
    const onLinked = await render({ mode: "self", identityLink: { linked: false } })
    type(field("email"), "editor@example.com")
    type(field("password"), "correct horse")
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })

    const signIn = calls.find((c) => c.url.includes("/auth/v1/token"))
    expect(signIn).toMatchObject({
      url: `${PROXY}/auth/v1/token?grant_type=password`,
      method: "POST",
      body: { email: "editor@example.com", password: "correct horse" },
    })
    const link = calls.find((c) => c.url.endsWith("/studio/identity-link"))
    expect(link).toMatchObject({
      url: "https://api.example.test/api/v1/projects/abc/studio/identity-link",
      method: "POST",
      body: { accessToken: "project-access-token" },
    })
    expect(onLinked).toHaveBeenCalledOnce()
  })
})
