// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { PlatformCtx, type PlatformContext } from "../src/hooks/usePlatform.js"
import { ConfigurationView } from "../src/views/auth/ConfigurationView.js"
import { ProvidersView } from "../src/views/auth/ProvidersView.js"
import { testClient } from "./support.js"

/**
 * Cloud (design note 13.7): the auth Configuration and Providers pages load and save through the
 * control plane's per-environment auth routes. Self-host keeps the read-only pages.
 */

const CLOUD: PlatformContext = { platformUrl: "https://api.example.test/api/v1", projectRef: "abc123", environment: "production" }
const SELF_HOST: PlatformContext = { platformUrl: undefined, projectRef: undefined, environment: "production" }
const CLIENT = testClient({ url: "https://api.example.test/api/v1/projects/abc123/proxy", token: "token" })
const ROUTE = "https://api.example.test/api/v1/projects/abc123/environments/production/auth"
const VERIFY = "https://api.example.test/api/v1/projects/abc123/studio/auth/verify"

interface Field {
  value: string | boolean | string[] | null
  source: "default" | "code" | "studio"
  codeValue: string | boolean | string[] | null
  differsFromCode: boolean
  updatedAt: string | null
  updatedBy: string | null
}

const field = (over: Partial<Field>): Field => ({ value: null, source: "default", codeValue: null, differsFromCode: false, updatedAt: null, updatedBy: null, ...over })

function viewBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "production",
    version: 5,
    appliedVersion: 5,
    appliedAt: "2026-11-13T09:00:00Z",
    fields: {
      "auth.siteUrl": field({ value: "https://studio-set.example.com", source: "studio", codeValue: "https://code-set.example.com", differsFromCode: true, updatedAt: "2026-11-13T10:00:00Z", updatedBy: "nic@example.com" }),
      "auth.disableSignup": field({ value: false, source: "code", codeValue: false, updatedAt: "2026-11-12T10:00:00Z", updatedBy: "cli" }),
      "auth.providers.github.enabled": field({ value: true, source: "code", codeValue: true }),
      "auth.providers.github.clientId": field({ value: "Iv1.abc", source: "code", codeValue: "Iv1.abc" }),
    },
    secrets: { "providers.github.secret": { set: true, fingerprint: "a1f9", source: "studio", updatedAt: null, updatedBy: null } },
    callbacks: { github: "https://api.example.test/auth/v1/callback" },
    platformRedirectUrls: ["https://studio.example.test/*"],
    platformSender: true,
    mailHourlyCap: 20,
    ...over,
  }
}

interface Sent { method: string; url: string; body: unknown }
let root: Root | null = null
let container: HTMLElement
let sent: Sent[] = []

function role(name: string, administer: boolean): Response {
  return Response.json({ sub: "u1", role: name, permissions: { administer } })
}

async function render(platform: PlatformContext, page: React.ReactElement, roleAnswer = role("owner", true), settings: Response | (() => Response) = () => Response.json(viewBody())): Promise<void> {
  sent = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    sent.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    if (url === VERIFY) return roleAnswer.clone()
    if (url === ROUTE) return typeof settings === "function" ? settings() : settings.clone()
    return Response.json({ external: { github: true } })
  })
  container = document.createElement("div")
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <PlatformCtx.Provider value={platform}>
        <AdminClientContext.Provider value={CLIENT}>{page}</AdminClientContext.Provider>
      </PlatformCtx.Provider>,
    ),
  )
  for (let i = 0; i < 6; i++) await act(async () => {})
}

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label || b.getAttribute("aria-label") === label)

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.unstubAllGlobals()
})

describe("the Cloud auth Configuration page", () => {
  it("loads the environment's auth settings from the control plane", async () => {
    await render(CLOUD, <ConfigurationView />)
    expect(sent.some((s) => s.method === "GET" && s.url === ROUTE)).toBe(true)
    expect(container.textContent).toContain("https://studio.example.test/*")
    expect(container.textContent).toContain("applied")
  })

  it("says a version the server has not applied is written, not yet applied", async () => {
    await render(CLOUD, <ConfigurationView />, role("owner", true), () => Response.json(viewBody({ appliedVersion: 4 })))
    expect(container.textContent).toContain("written, not yet applied")
  })

  it("shows the platform sender notice and the hourly cap", async () => {
    await render(CLOUD, <ConfigurationView />)
    expect(container.textContent).toContain("platform sender")
    expect(container.textContent).toContain("20")
  })

  it("flags a Studio value masking a code value and Reset sends the path", async () => {
    await render(CLOUD, <ConfigurationView />)
    expect(container.textContent).toContain("Differs from config")
    expect(container.textContent).toContain("Studio edit")
    await act(async () => { button("Reset")!.click() })
    const put = sent.find((s) => s.method === "PUT")
    expect(put?.url).toBe(ROUTE)
    expect(put?.body).toEqual({ reset: ["auth.siteUrl"] })
  })

  it("saves an edited value as a set body", async () => {
    await render(CLOUD, <ConfigurationView />)
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Site URL"]')!
    await type(input, "https://new.example.com")
    await act(async () => { button("Save Site URL")!.click() })
    expect(sent.find((s) => s.method === "PUT")?.body).toEqual({ set: { "auth.siteUrl": "https://new.example.com" } })
  })

  it("gives a viewer the values and no inputs", async () => {
    await render(CLOUD, <ConfigurationView />, role("viewer", false))
    expect(container.textContent).toContain("https://studio-set.example.com")
    expect(container.querySelector("input, textarea, select, [role=switch]")).toBeNull()
    expect(button("Reset")).toBeUndefined()
  })
})

describe("the Cloud auth Providers page", () => {
  it("shows the callback URL and the register-it warning", async () => {
    await render(CLOUD, <ProvidersView />)
    expect(container.textContent).toContain("https://api.example.test/auth/v1/callback")
    expect(container.textContent).toContain("one callback URL")
  })

  it("shows a secret as set with its fingerprint and never fills an input with it", async () => {
    await render(CLOUD, <ProvidersView />)
    expect(container.textContent).toContain("set (...a1f9)")
    const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(secret.value).toBe("")
  })

  it("sends a replaced secret once and clears the input", async () => {
    await render(CLOUD, <ProvidersView />)
    const secret = container.querySelector<HTMLInputElement>('input[aria-label="github secret"]')!
    await type(secret, "s3cret-value")
    await act(async () => { button("Replace github secret")!.click() })
    expect(sent.find((s) => s.method === "PUT")?.body).toEqual({ secrets: { "providers.github.secret": "s3cret-value" } })
    expect(container.querySelector<HTMLInputElement>('input[aria-label="github secret"]')!.value).toBe("")
    expect(container.innerHTML).not.toContain("s3cret-value")
  })

  it("removes a secret by sending null", async () => {
    await render(CLOUD, <ProvidersView />)
    await act(async () => { button("Remove github secret")!.click() })
    expect(sent.find((s) => s.method === "PUT")?.body).toEqual({ secrets: { "providers.github.secret": null } })
  })

  it("gives a viewer no inputs", async () => {
    await render(CLOUD, <ProvidersView />, role("viewer", false))
    expect(container.querySelector("input, textarea, select, [role=switch]")).toBeNull()
    expect(container.textContent).toContain("set (...a1f9)")
  })
})

describe("self-host", () => {
  it("keeps the read-only Configuration page and never calls the control plane", async () => {
    await render(SELF_HOST, <ConfigurationView />)
    expect(sent.some((s) => s.url.includes("/environments/"))).toBe(false)
    expect(container.querySelector("input, textarea")).toBeNull()
    expect(container.textContent).toContain("Studio cannot change them")
  })

  it("keeps the read-only Providers page", async () => {
    await render(SELF_HOST, <ProvidersView />)
    expect(sent.some((s) => s.url.includes("/environments/"))).toBe(false)
    expect(container.querySelector("input, textarea")).toBeNull()
  })
})
