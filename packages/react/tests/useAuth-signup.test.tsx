/**
 * A sign-up that waits for email confirmation leaves `useAuth` signed out.
 *
 * The auth server answers it with the bare user and no tokens. Treating that as a session showed
 * apps a blank signed-in user (id "") that survived a reload.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient } from "@supatype/client"
import { SupatypeProvider } from "../src/context.js"
import { useAuth, type UseAuthReturn } from "../src/useAuth.js"

const PENDING_USER = {
  id: "user-pending",
  email: "ada@example.com",
  confirmation_sent_at: "2024-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
}

const probe: { auth: UseAuthReturn | null } = { auth: null }

function Probe(): React.ReactElement {
  const auth = useAuth()
  probe.auth = auth
  return <p>{auth.loading ? "loading" : auth.user === null ? "signed out" : `signed in as "${auth.user.id}"`}</p>
}

async function renderApp(): Promise<ReactTestRenderer> {
  const client = createClient({ url: "http://localhost:9999", anonKey: "anon" })
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(<SupatypeProvider client={client}><Probe /></SupatypeProvider>)
    await client.auth.getSession()
  })
  return renderer!
}

afterEach(() => {
  vi.unstubAllGlobals()
  probe.auth = null
})

describe("useAuth after a sign-up waiting for email confirmation", () => {
  it("stays signed out and returns no session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(PENDING_USER), { status: 200 })))
    const renderer = await renderApp()

    let session: unknown = "unset"
    await act(async () => {
      session = (await probe.auth!.signUp({ email: "ada@example.com", password: "secret-pass" })).data.session
    })

    expect(session).toBeNull()
    expect(renderer.root.findByType("p").children.join("")).toBe("signed out")
  })
})
