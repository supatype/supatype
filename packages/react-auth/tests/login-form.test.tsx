/**
 * LoginForm over the real client: what a sign-in or a refusal from `/token` makes of the form.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactTestRenderer } from "react-test-renderer"
import { LoginForm } from "../src/index.js"
import { render, submit, type } from "./helpers.js"

const TOKEN_RESPONSE = {
  access_token: "access-token",
  token_type: "bearer",
  expires_in: 3600,
  refresh_token: "refresh-token",
  user: {
    id: "user-1",
    email: "ada@example.com",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    app_metadata: {},
    user_metadata: {},
  },
}

async function signIn(renderer: ReactTestRenderer): Promise<void> {
  type(renderer, "st-login-email", "ada@example.com")
  type(renderer, "st-login-password", "secret-pass")
  await submit(renderer)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("LoginForm", () => {
  it("hands the new session to onSuccess", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(TOKEN_RESPONSE), { status: 200 })))
    const onSuccess = vi.fn()
    const renderer = render(<LoginForm onSuccess={onSuccess} />)
    await signIn(renderer)
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "access-token" }))
  })

  it("shows the refusal after the errorPrefix label and calls onError", async () => {
    const refusal = { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(refusal), { status: 400 })))
    const onError = vi.fn()
    const renderer = render(<LoginForm onError={onError} labels={{ errorPrefix: "Sign-in failed: " }} />)
    await signIn(renderer)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid_credentials" }))
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe("Sign-in failed: Invalid login credentials")
  })

  it("reports a request that never reached the server instead of leaving the form spinning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    const onError = vi.fn()
    const renderer = render(<LoginForm onError={onError} />)
    await signIn(renderer)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "NETWORK_ERROR" }))
    expect(renderer.root.findByType("button").props["disabled"]).toBe(false)
  })
})
