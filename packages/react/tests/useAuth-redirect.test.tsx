/**
 * An OAuth sign-in finishes on the page the auth server returns to, with nothing in the app.
 *
 * The server sends the browser back with the session in the URL. `SupatypeProvider` and `useAuth`
 * have to show that user (and a refusal) once the client has read it, or the round trip lands on a
 * signed-out page with tokens in the address bar.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useAuth } from "../src/useAuth.js"

const RAW_USER = {
  id: "user-1",
  email: "ada@example.com",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "github" },
  user_metadata: { full_name: "Ada Lovelace" },
}

function accessToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

function stubBrowser(href: string): ReturnType<typeof vi.fn> {
  const store = new Map<string, string>([["supatype.auth.session-oauth-provider", "github"]])
  const replaceState = vi.fn()
  vi.stubGlobal("window", {
    location: { href, protocol: "https:" },
    history: { state: null, replaceState },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
  })
  return replaceState
}

function Probe(): React.ReactElement {
  const { user, loading, error } = useAuth()
  const text = loading ? "loading" : user?.email ?? `signed out${error ? `: ${error.message} (${error.provider ?? "?"})` : ""}`
  return <p>{text}</p>
}

async function renderApp(): Promise<ReactTestRenderer> {
  const client = createClient({ url: "http://localhost:9999", anonKey: "anon" })
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(<SupatypeProvider client={client}><Probe /></SupatypeProvider>)
    await client.auth.getSession()
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return renderer!
}

function shown(renderer: ReactTestRenderer): string {
  return renderer.root.findByType("p").children.join("")
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useAuth after an OAuth redirect", () => {
  it("shows the user the URL signed in, and cleans the URL", async () => {
    const replaceState = stubBrowser(`https://app.example/#access_token=${accessToken()}&refresh_token=rt-1&sb=`)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(RAW_USER), { status: 200 })))

    const renderer = await renderApp()

    expect(shown(renderer)).toBe("ada@example.com")
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://app.example/")
  })

  it("exposes a refusal the server reported in the URL", async () => {
    stubBrowser("https://app.example/?error=server_error&error_description=Error+getting+user+profile#error=server_error&error_description=Error+getting+user+profile&sb=")
    vi.stubGlobal("fetch", vi.fn())

    const renderer = await renderApp()

    expect(shown(renderer)).toBe("signed out: Error getting user profile (github)")
  })
})
