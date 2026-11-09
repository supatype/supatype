/**
 * `useAuth().signInWithSSO`: SAML single sign-on from a component, beside `signInWithOAuth`. It is
 * the client's own `signInWithSSO`, so what the auth server receives is asserted here.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create } from "react-test-renderer"
import { createClient, PKCE_METHOD_S256 } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useAuth, type UseAuthReturn } from "../src/useAuth.js"

const IDP_URL = "https://idp.example/sso?SAMLRequest=abc"
const PROVIDER_ID = "8a6f1f4e-2b1c-4f5e-9d3a-6b7c8d9e0f1a"

const probe: { auth: UseAuthReturn | null } = { auth: null }

function Probe(): React.ReactElement {
  probe.auth = useAuth()
  return <p />
}

/** Render a provider over a real client and record the requests it sends. */
async function renderApp(): Promise<Array<{ url: string; body: unknown }>> {
  const sent: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    sent.push({ url: input, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null })
    return new Response(JSON.stringify({ url: IDP_URL }), { status: 200 })
  }))
  const client = createClient({ url: "http://localhost:9999", anonKey: "anon" })
  await act(async () => {
    create(<SupatypeProvider client={client}><Probe /></SupatypeProvider>)
    await client.auth.getSession()
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
  probe.auth = null
})

describe("useAuth().signInWithSSO", () => {
  it("starts SSO for an email domain and returns the identity provider's URL", async () => {
    const sent = await renderApp()
    const result = await probe.auth!.signInWithSSO({ domain: "acme.com", options: { skipBrowserRedirect: true } })

    expect(result).toEqual({ data: { url: IDP_URL }, error: null })
    const sso = sent.find((r) => r.url === "http://localhost:9999/auth/v1/sso")
    expect(sso?.body).toMatchObject({ domain: "acme.com", skip_http_redirect: true, code_challenge_method: PKCE_METHOD_S256 })
  })

  it("starts SSO for a provider named by its ID", async () => {
    const sent = await renderApp()
    await probe.auth!.signInWithSSO({ providerId: PROVIDER_ID, options: { skipBrowserRedirect: true } })

    expect(sent.find((r) => r.url.endsWith("/auth/v1/sso"))?.body).toMatchObject({ provider_id: PROVIDER_ID })
  })

  it("takes a domain or a provider ID, never both", async () => {
    await renderApp()
    const both = (): unknown =>
      // @ts-expect-error: one of domain or providerId, never both
      probe.auth!.signInWithSSO({ domain: "acme.com", providerId: PROVIDER_ID })
    expect(typeof both).toBe("function")
  })
})
