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
}

let root: Root | null = null
let container: HTMLElement
let seen: Seen[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** The auth server and the gateway, answering only what a sign-in asks. */
function serve(member: boolean): void {
  seen = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    seen.push({ url, method: init?.method ?? "GET" })
    if (url === `${API}/auth/v1/settings`) return json(SETTINGS)
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

    expect(seen).toContainEqual({ url: `${API}/auth/v1/token?grant_type=pkce`, method: "POST" })
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
