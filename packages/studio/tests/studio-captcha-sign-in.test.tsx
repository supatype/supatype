// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createClient } from "@supatype/client"
import { StudioAccessGate } from "../src/components/StudioAccessGate.js"
import { browserNavigation } from "../src/lib/browser-navigation.js"

/**
 * FF-12: with auth.captcha on, nobody could sign in to self-host Studio. The form sent no token, so
 * the auth server answered `captcha_failed` to every attempt. The server's public settings now say
 * which provider and site key are in use; Studio draws that provider's widget, holds the sign-in
 * until the widget has answered, and sends the answer in `supatype_meta_security.captcha_token`.
 */

const API = "http://localhost:18540"

const TOKEN = {
  access_token: "header.eyJleHAiOjQxMDI0NDQ4MDB9.sig",
  refresh_token: "refresh",
  token_type: "bearer",
  expires_in: 3600,
  user: { id: "u1", email: "admin@example.com", app_metadata: {}, user_metadata: {}, created_at: "", updated_at: "" },
}

interface Seen {
  url: string
  body?: unknown
}

interface WidgetOptions {
  sitekey: string
  callback(token: string): void
  "expired-callback"(): void
}

/** What a provider's script puts on `window`: it records the widgets drawn and the resets asked for. */
interface ProviderStub {
  render: ReturnType<typeof vi.fn<(el: HTMLElement, options: WidgetOptions) => string>>
  reset: ReturnType<typeof vi.fn<(id: string) => void>>
  remove: ReturnType<typeof vi.fn<(id: string) => void>>
}

function providerStub(): ProviderStub {
  return { render: vi.fn(() => "widget-1"), reset: vi.fn(), remove: vi.fn() }
}

let root: Root | null = null
let container: HTMLElement
let seen: Seen[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function serve(settings: object): void {
  seen = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    seen.push({ url, ...(body !== undefined && { body }) })
    if (url === `${API}/auth/v1/settings`) return json(settings)
    if (url === `${API}/auth/v1/token?grant_type=password`) return json(TOKEN)
    if (url === `${API}/auth/v1/sso`) return json({ url: "https://idp.acme.com/sso" })
    if (url === `${API}/studio/auth/verify`) return json({ allowed: true })
    return json({ error: "unexpected" }, 404)
  })
}

async function mount(): Promise<void> {
  const authClient = createClient({ url: API, anonKey: "anon-key", auth: { storageKey: "supatype.auth.session" } })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <StudioAccessGate apiBaseUrl={API} anonKey="anon-key" authClient={authClient}>
        {() => <p>Studio is open</p>}
      </StudioAccessGate>,
    ),
  )
  for (let i = 0; i < 10; i++) await act(async () => {})
}

function typeInto(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
  input?.dispatchEvent(new Event("input", { bubbles: true }))
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text)
  if (found === undefined) throw new Error(`no "${text}" button`)
  return found
}

async function signIn(): Promise<void> {
  await act(async () => typeInto("#studio-login-email", "admin@example.com"))
  await act(async () => typeInto("#studio-login-password", "a-good-password"))
  await act(async () => button("Sign in").click())
  for (let i = 0; i < 6; i++) await act(async () => {})
}

const CAPTCHA_ON = { external: { email: true }, captcha: { provider: "hcaptcha", site_key: "site-key-123" } }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  // A signed-in client leaves its session in this cookie, which the next test would start from.
  document.cookie = "st-auth-token=; Max-Age=0; path=/"
  window.history.replaceState(null, "", "/studio/")
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, "hcaptcha")
  Reflect.deleteProperty(window, "turnstile")
  document.head.querySelectorAll("script[data-captcha]").forEach((s) => s.remove())
})

describe("Studio sign-in on a project with captcha on", () => {
  it("draws the provider's widget for the site key the server reports, and holds Sign in until it answers", async () => {
    const hcaptcha = providerStub()
    Object.assign(window, { hcaptcha })
    serve(CAPTCHA_ON)
    await mount()

    expect(hcaptcha.render).toHaveBeenCalledTimes(1)
    expect(hcaptcha.render.mock.calls[0]![1].sitekey).toBe("site-key-123")
    expect(button("Sign in").disabled).toBe(true)

    await act(async () => hcaptcha.render.mock.calls[0]![1].callback("answer-1"))
    expect(button("Sign in").disabled).toBe(false)
  })

  it("sends the widget's answer with the password sign-in, in the body field the auth server reads", async () => {
    const hcaptcha = providerStub()
    Object.assign(window, { hcaptcha })
    serve(CAPTCHA_ON)
    await mount()
    await act(async () => hcaptcha.render.mock.calls[0]![1].callback("answer-1"))

    await signIn()

    const attempt = seen.find((r) => r.url === `${API}/auth/v1/token?grant_type=password`)
    expect(attempt?.body).toMatchObject({ email: "admin@example.com", supatype_meta_security: { captcha_token: "answer-1" } })
    expect(container.textContent).toContain("Studio is open")
  })

  it("asks the widget for a new answer once an attempt has used the old one", async () => {
    const hcaptcha = providerStub()
    Object.assign(window, { hcaptcha })
    serve({ ...CAPTCHA_ON })
    seen = []
    await mount()
    await act(async () => hcaptcha.render.mock.calls[0]![1].callback("answer-1"))
    // A sign-in the server turns down, so the page stays up and the answer is spent.
    vi.stubGlobal("fetch", async () => json({ error_description: "Invalid login credentials" }, 400))

    await signIn()

    expect(button("Sign in").disabled).toBe(true)
    expect(hcaptcha.remove).toHaveBeenCalled()
    expect(hcaptcha.render.mock.calls.length).toBeGreaterThan(1)
  })

  it("uses Turnstile when that is the provider", async () => {
    const turnstile = providerStub()
    Object.assign(window, { turnstile })
    serve({ external: { email: true }, captcha: { provider: "turnstile", site_key: "0x4AAA" } })
    await mount()

    expect(turnstile.render).toHaveBeenCalledTimes(1)
    expect(turnstile.render.mock.calls[0]![1].sitekey).toBe("0x4AAA")
  })

  it("loads the provider's script when the page does not have it yet, and draws the widget once it has loaded", async () => {
    serve(CAPTCHA_ON)
    await mount()

    const script = document.head.querySelector<HTMLScriptElement>("script[data-captcha]")
    expect(script?.src).toBe("https://js.hcaptcha.com/1/api.js?render=explicit")

    const hcaptcha = providerStub()
    Object.assign(window, { hcaptcha })
    await act(async () => script!.dispatchEvent(new Event("load")))
    expect(hcaptcha.render).toHaveBeenCalledTimes(1)
  })

  it("sends the answer with a single sign-on attempt too, which the server also checks", async () => {
    const hcaptcha = providerStub()
    Object.assign(window, { hcaptcha })
    vi.spyOn(browserNavigation, "assign").mockImplementation(() => {})
    serve({ ...CAPTCHA_ON, saml_enabled: true })
    await mount()
    await act(async () => hcaptcha.render.mock.calls[0]![1].callback("answer-sso"))

    await act(async () => typeInto("#studio-login-sso-email", "admin@acme.com"))
    await act(async () => button("Sign in with SSO").click())
    for (let i = 0; i < 6; i++) await act(async () => {})

    const sso = seen.find((r) => r.url === `${API}/auth/v1/sso`)
    expect(sso?.body).toMatchObject({ domain: "acme.com", supatype_meta_security: { captcha_token: "answer-sso" } })
  })
})

describe("Studio sign-in on a project with captcha off", () => {
  it("draws no widget, loads no script and sends no token", async () => {
    const hcaptcha = providerStub()
    Object.assign(window, { hcaptcha })
    serve({ external: { email: true } })
    await mount()

    expect(hcaptcha.render).not.toHaveBeenCalled()
    expect(document.head.querySelector("script[data-captcha]")).toBeNull()
    expect(button("Sign in").disabled).toBe(false)

    await signIn()
    const attempt = seen.find((r) => r.url === `${API}/auth/v1/token?grant_type=password`)
    expect(attempt?.body).not.toHaveProperty("supatype_meta_security")
  })

  it("ignores a captcha block it cannot use: an unknown provider, or no site key", async () => {
    const hcaptcha = providerStub()
    Object.assign(window, { hcaptcha })
    serve({ external: { email: true }, captcha: { provider: "recaptcha", site_key: "x" } })
    await mount()
    expect(hcaptcha.render).not.toHaveBeenCalled()
    expect(button("Sign in").disabled).toBe(false)
  })
})
