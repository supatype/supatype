/**
 * usePasswordRecovery over the real client: a recovery that produces a session turns it on, and
 * `finish` or a sign-out turns it off.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient, type SupatypeClient } from "@supatype/client"
import { SupatypeProvider } from "@supatype/react"
import { usePasswordRecovery, type PasswordRecovery } from "../src/index.js"
import { API } from "./helpers.js"

const TOKEN_RESPONSE = {
  access_token: "recovery-access-token",
  token_type: "bearer",
  expires_in: 3600,
  refresh_token: "recovery-refresh-token",
  user: { id: "user-1", email: "ada@example.com", created_at: "", updated_at: "", app_metadata: {}, user_metadata: {} },
}

function mount(): { client: SupatypeClient; latest: () => PasswordRecovery } {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(TOKEN_RESPONSE), { status: 200 })))
  const client = createClient({ url: API, anonKey: "anon" })
  let seen: PasswordRecovery | null = null
  function Probe(): null {
    seen = usePasswordRecovery()
    return null
  }
  let renderer: ReactTestRenderer | null = null
  act(() => { renderer = create(<SupatypeProvider client={client}><Probe /></SupatypeProvider>) })
  expect(renderer).not.toBeNull()
  return { client, latest: () => seen! }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("usePasswordRecovery", () => {
  it("is active once a recovery produces a session, until finish", async () => {
    const { client, latest } = mount()
    expect(latest().active).toBe(false)

    await act(async () => { await client.auth.verifyOtp({ type: "recovery", token: "", tokenHash: "hash" }) })
    expect(latest().active).toBe(true)

    act(() => { latest().finish() })
    expect(latest().active).toBe(false)
  })

  it("stays off for an ordinary sign-in and ends on sign-out", async () => {
    const { client, latest } = mount()
    await act(async () => { await client.auth.signInWithPassword({ email: "ada@example.com", password: "x" }) })
    expect(latest().active).toBe(false)

    await act(async () => { await client.auth.verifyOtp({ type: "recovery", token: "", tokenHash: "hash" }) })
    expect(latest().active).toBe(true)
    await act(async () => { await client.auth.signOut() })
    expect(latest().active).toBe(false)
  })
})
