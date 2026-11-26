// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { StudioCore } from "../src/StudioCore.js"
import { isolateEachTest, mount, settle, testClient, testConfig } from "./support.js"

/**
 * D-67: data hooks run as functions and read the same secrets from ctx.env, so Studio's Hooks page
 * shows the one function-secrets component. It is separate from Authentication > Hooks (auth hooks),
 * and works on Cloud the way the Functions view does.
 */

const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "token" })

interface Seen { urls: string[] }

/** A server that signs the caller in as an admin and answers the secrets lists. */
function backend(seen: Seen): (input: RequestInfo | URL) => Promise<Response> {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input)
    seen.urls.push(url)
    if (url.endsWith("/studio/auth/verify")) {
      return Promise.resolve(Response.json({ role: "admin", sub: "u1", permissions: { administer: true } }))
    }
    if (/\/functions\/env$/.test(url)) return Promise.resolve(Response.json({ data: ["STRIPE_KEY"] }))
    return new Promise<Response>(() => {})
  }
}

isolateEachTest()

async function open(path: string, hostedByCloud: boolean, seen: Seen): Promise<HTMLElement> {
  vi.stubGlobal("fetch", backend(seen))
  const { container } = await mount(
    <MemoryRouter initialEntries={[path]}>
      <StudioCore
        config={testConfig()}
        client={CLIENT}
        {...(hostedByCloud && { platformUrl: "/api/control-plane", projectRef: "abc123" })}
      />
    </MemoryRouter>,
  )
  await settle()
  return container
}

describe("the Hooks page", () => {
  it("shows the shared function secrets with a note that hooks read them from ctx.env", async () => {
    const seen: Seen = { urls: [] }
    const container = await open("/hooks", false, seen)
    const page = container.querySelector("main")?.textContent ?? ""
    expect(page).toContain("Function secrets")
    expect(page).toContain("STRIPE_KEY")
    expect(page).toContain("Data hooks")
    expect(seen.urls.some((u) => u.endsWith("/admin/v1/functions/env"))).toBe(true)
  })

  it("is in the sidebar, apart from Authentication > Hooks", async () => {
    const container = await open("/hooks", false, { urls: [] })
    const entry = container.querySelector('[aria-label="Studio navigation"] [aria-current="page"]')
    expect(entry?.getAttribute("aria-label") ?? entry?.textContent).toContain("Hooks")
    expect(container.querySelector("main")?.textContent).not.toContain("Auth hooks")
  })

  it("reads the secrets from the control plane's project route when Cloud hosts it", async () => {
    const seen: Seen = { urls: [] }
    const container = await open("/hooks", true, seen)
    expect(seen.urls).toContain("/api/control-plane/projects/abc123/functions/env")
    expect(seen.urls.some((u) => u.includes("/admin/v1/functions/env"))).toBe(false)
    expect(container.querySelector("main")?.textContent).toContain("STRIPE_KEY")
  })
})
