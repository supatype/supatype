/**
 * SignUpForm asks the user to confirm their email when the project requires it.
 *
 * Runs over the real client and `useAuth`: the auth server answers such a sign-up with the bare
 * user and no tokens, and the form only shows its message when that reaches it as a null session.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createClient } from "@supatype/client"
import { SupatypeProvider } from "@supatype/react"
import { SignUpForm } from "../src/index.js"
import { fire } from "./props.js"
import { type } from "./helpers.js"

const PENDING_USER = {
  id: "user-pending",
  email: "ada@example.com",
  confirmation_sent_at: "2024-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("SignUpForm when the project requires email confirmation", () => {
  it("shows the confirmation message and reports a null session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(PENDING_USER), { status: 200 })))
    const client = createClient({ url: "http://localhost:9999", anonKey: "anon" })
    const onSuccess = vi.fn()
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(<SupatypeProvider client={client}><SignUpForm onSuccess={onSuccess} /></SupatypeProvider>)
      await client.auth.getSession()
    })
    type(renderer!, "st-signup-email", "ada@example.com")
    type(renderer!, "st-signup-password", "secret-pass")

    const form = renderer!.root.findByType("form")
    await act(async () => { await fire(form, "onSubmit", { preventDefault: () => undefined }) })

    expect(onSuccess).toHaveBeenCalledWith(null)
    expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toBe("Check your email to confirm your account.")
  })
})
