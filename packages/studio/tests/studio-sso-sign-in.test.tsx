// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createClient } from "@supatype/client"
import { StudioAccessGate } from "../src/components/StudioAccessGate.js"
import { browserNavigation } from "../src/lib/browser-navigation.js"

/**
 * Studio's sign-in offered email and password only, so a project with Keycloak or GitHub enabled
 * could not use them for Studio. It now shows a button per OAuth provider the auth server reports
 * enabled (narrowed by `studio.auth.providers` when the project sets it), starts a PKCE sign-in
 * flagged `studio=1` so the server returns the browser to Studio, finishes that sign-in when Studio
 * loads with the code, and then runs the same access check as a password sign-in: no Studio role
 * means "Access denied".
 */

const API = "http://localhost:18540"
const STORAGE_KEY = "supatype.auth.session"

const SETTINGS = {
  external: { email: true, phone: false, anonymous_users: false, github: true, google: false, keycloak: true },
}

const TOKEN = {
  access_token: "header.eyJleHAiOjQxMDI0NDQ4MDB9.sig",
  refresh_token: "refresh",
  token_type: "bearer",
  expires_in: 3600,
  user: { id: "sso-user", email: "sso-tester@example.com", app_metadata: {}, user_metadata: {}, created_at: "", updated_at: "" },
}

interface Seen {
  url: string
  method: string
  body?: unknown
}

const IDP_URL = "https://idp.acme.com/sso?SAMLRequest=abc&RelayState=r1"

let root: Root | null = null
let container: HTMLElement
let seen: Seen[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** `POST /sso`: a provider for acme.com, and the server's refusal for any other domain. */
function answerSSO(body: unknown): Response {
  const domain = typeof body === "object" && body !== null && "domain" in body ? body.domain : undefined
  if (domain === "acme.com") return json({ url: IDP_URL })
  return json({ code: 404, error_code: "sso_provider_not_found", msg: "No SSO provider assigned for this domain" }, 404)
}

/** The auth server and the gateway, answering only what a sign-in asks. */
function serve(member: boolean, settings: object = SETTINGS): void {
  seen = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    seen.push({ url, method: init?.method ?? "GET", ...(body !== undefined && { body }) })
    if (url === `${API}/auth/v1/settings`) return json(settings)
    if (url === `${API}/auth/v1/sso`) return answerSSO(body)
    if (url === `${API}/auth/v1/token?grant_type=pkce`) return json(TOKEN)
    if (url === `${API}/studio/auth/verify`) {
      return member ? json({ allowed: true }) : json({ error: "You have no Studio role for this project." }, 403)
    }
    return json({ error: "unexpected" }, 404)
  })
}

async function mount(): Promise<void> {
  const authClient = createClient({ url: API, anonKey: "anon-key", auth: { storageKey: STORAGE_KEY } })
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

function providerButtons(): string[] {
  return [...container.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .filter((text) => text.startsWith("Continue with"))
}

function setRuntimeProviders(providers: string[] | undefined): void {
  if (providers === undefined) Reflect.deleteProperty(window, "__SUPATYPE_CLOUD__")
  else Object.assign(window, { __SUPATYPE_CLOUD__: { authProviders: providers } })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  window.history.replaceState(null, "", "/studio/")
  setRuntimeProviders(undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setRuntimeProviders(undefined)
})

describe("Studio sign-in with the project's providers", () => {
  it("offers every OAuth provider the auth server reports enabled, and keeps email and password", async () => {
    serve(true)
    await mount()

    expect(providerButtons()).toEqual(["Continue with GitHub", "Continue with Keycloak"])
    expect(container.querySelector("#studio-login-email")).not.toBeNull()
    expect(seen.map((r) => r.url)).toContain(`${API}/auth/v1/settings`)
  })

  it("offers only the providers studio.auth.providers names", async () => {
    setRuntimeProviders(["keycloak", "google"])
    serve(true)
    await mount()

    // google is named but disabled on the server, so it is not offered.
    expect(providerButtons()).toEqual(["Continue with Keycloak"])
  })

  it("starts a PKCE sign-in flagged for Studio, with no return address of its own", async () => {
    serve(true)
    const assign = vi.spyOn(browserNavigation, "assign").mockImplementation(() => {})
    await mount()

    const keycloak = [...container.querySelectorAll("button")].find((b) => b.textContent === "Continue with Keycloak")
    await act(async () => keycloak!.click())
    for (let i = 0; i < 5; i++) await act(async () => {})

    expect(assign).toHaveBeenCalledTimes(1)
    const target = new URL(assign.mock.calls[0]![0])
    expect(`${target.origin}${target.pathname}`).toBe(`${API}/auth/v1/authorize`)
    expect(target.searchParams.get("provider")).toBe("keycloak")
    expect(target.searchParams.get("studio")).toBe("1")
    expect(target.searchParams.get("code_challenge_method")).toBe("s256")
    expect(target.searchParams.get("code_challenge")).not.toBeNull()
    expect(target.searchParams.get("redirect_to")).toBeNull()
    expect(localStorage.getItem(`${STORAGE_KEY}-code-verifier`)).not.toBeNull()
  })

  it("finishes the sign-in when Studio loads with the code, then opens for a member", async () => {
    localStorage.setItem(`${STORAGE_KEY}-code-verifier`, "verifier-from-the-click")
    window.history.replaceState(null, "", "/studio/?code=auth-code")
    serve(true)
    await mount()

    expect(seen).toContainEqual(expect.objectContaining({ url: `${API}/auth/v1/token?grant_type=pkce`, method: "POST" }))
    expect(seen.map((r) => r.url)).toContain(`${API}/studio/auth/verify`)
    expect(container.textContent).toContain("Studio is open")
    expect(window.location.search).toBe("")
  })

  it("says Access denied to somebody with no Studio role", async () => {
    localStorage.setItem(`${STORAGE_KEY}-code-verifier`, "verifier-from-the-click")
    window.history.replaceState(null, "", "/studio/?code=auth-code")
    serve(false)
    await mount()

    expect(container.textContent).toContain("Access denied")
    expect(container.textContent).toContain("You have no Studio role for this project.")
    expect(container.textContent).not.toContain("Studio is open")
  })

  it("shows a refused sign-in on the sign-in page", async () => {
    window.history.replaceState(null, "", "/studio/?error=access_denied&error_description=Signups+not+allowed+for+this+instance")
    serve(true)
    await mount()

    expect(container.querySelector("[role=alert]")?.textContent).toContain("Signups not allowed for this instance")
    expect(providerButtons()).toEqual(["Continue with GitHub", "Continue with Keycloak"])
  })
})

/** The settings of a project with SAML on, and email sign-in on or off. */
function samlSettings(email: boolean): typeof SETTINGS & { saml_enabled: boolean } {
  return { external: { ...SETTINGS.external, email }, saml_enabled: true }
}

function ssoField(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>("#studio-login-sso-email")
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text)
}

/** Types into a React-controlled input, as a person would. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

async function signInWithSSO(email: string): Promise<void> {
  await act(async () => typeInto(ssoField()!, email))
  await act(async () => button("Sign in with SSO")!.click())
  for (let i = 0; i < 5; i++) await act(async () => {})
}

describe("Studio sign-in with the project's SAML providers (0.9.2 release test, N-FF3)", () => {
  it("offers single sign-on by work email when the auth server reports SAML on", async () => {
    serve(true, samlSettings(true))
    await mount()

    expect(ssoField()).not.toBeNull()
    expect(button("Sign in with SSO")).toBeDefined()
    expect(container.querySelector("#studio-login-email")).not.toBeNull()
  })

  it("offers no single sign-on when SAML is off", async () => {
    serve(true)
    await mount()

    expect(ssoField()).toBeNull()
    expect(button("Sign in with SSO")).toBeUndefined()
  })

  it("says so when the project leaves Studio no way to sign in", async () => {
    serve(true, { external: { email: false } })
    await mount()

    expect(container.querySelector("form")).toBeNull()
    expect(container.textContent).toContain("This project has no sign-in method Studio can offer.")
  })

  it("hides email and password when email sign-in is off, and keeps SSO and the OAuth providers", async () => {
    serve(true, samlSettings(false))
    await mount()

    expect(container.querySelector("#studio-login-email")).toBeNull()
    expect(container.querySelector("#studio-login-password")).toBeNull()
    expect(ssoField()).not.toBeNull()
    expect(providerButtons()).toEqual(["Continue with GitHub", "Continue with Keycloak"])
  })

  it("starts a PKCE SAML sign-in for the email's domain, flagged for Studio", async () => {
    serve(true, samlSettings(false))
    const assign = vi.spyOn(browserNavigation, "assign").mockImplementation(() => {})
    await mount()

    await signInWithSSO("admin@Acme.com")

    const sso = seen.find((r) => r.url === `${API}/auth/v1/sso`)
    expect(sso?.method).toBe("POST")
    expect(sso?.body).toMatchObject({ domain: "acme.com", studio: true, skip_http_redirect: true, code_challenge_method: "s256" })
    expect(sso?.body).not.toHaveProperty("redirect_to")
    expect(assign).toHaveBeenCalledWith(IDP_URL)
    expect(localStorage.getItem(`${STORAGE_KEY}-code-verifier`)).not.toBeNull()
  })

  // The field is a required `type="email"`, so the form submits only an email address. That is why
  // Studio can share `ssoDomain` with `<SSOForm>`, which also reads a bare domain as one.
  it("sends nothing for an address that is not an email, which the field refuses", async () => {
    serve(true, samlSettings(false))
    await mount()

    await signInWithSSO("admin")

    expect(seen.map((r) => r.url)).not.toContain(`${API}/auth/v1/sso`)
  })

  it("shows the auth server's refusal, such as a domain with no provider", async () => {
    serve(true, samlSettings(false))
    const assign = vi.spyOn(browserNavigation, "assign").mockImplementation(() => {})
    await mount()

    await signInWithSSO("admin@unknown.example")

    expect(assign).not.toHaveBeenCalled()
    expect(container.querySelector("[role=alert]")?.textContent).toContain("No SSO provider assigned for this domain")
  })
})
