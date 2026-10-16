/**
 * ForgotPasswordForm, MagicLinkForm and UpdatePasswordForm, over the real client.
 *
 * Each form is rendered inside a `SupatypeProvider` holding a real `createClient`, with only `fetch`
 * stubbed, so what is asserted is the request the auth server would receive (endpoint, method,
 * `redirect_to`, body) and what the form makes of the server's answer.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Session } from "@supatype/client"
import {
  ForgotPasswordForm,
  MagicLinkForm,
  UpdatePasswordForm,
  type AuthFormClassNames,
} from "../src/index.js"
import { classesOf, render, submit, textOf, type } from "./helpers.js"

const USER = {
  id: "user-1",
  email: "ada@example.com",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
}

const RECOVERY_SESSION: Session = {
  accessToken: "recovery-access-token",
  tokenType: "bearer",
  expiresIn: 3600,
  refreshToken: "recovery-refresh-token",
  user: { id: "user-1", email: "ada@example.com", appMetadata: {}, userMetadata: {}, createdAt: "", updatedAt: "" },
}

const CLASS_NAMES: AuthFormClassNames = {
  title: "t-title",
  error: "t-error",
  field: "t-field",
  label: "t-label",
  input: "t-input",
  submit: "t-submit",
  message: "t-message",
}

interface SentRequest {
  url: URL
  method: string
  body: unknown
  authorization: string | null
}

/** Stub `fetch` with one answer and record every request the client sends. */
function stubFetch(status: number, body: unknown): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    sent.push({
      url: new URL(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
      authorization: headers.get("Authorization"),
    })
    return new Response(JSON.stringify(body), { status })
  }))
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ForgotPasswordForm", () => {
  it("asks /recover to email a reset link that returns to redirectTo, then says to check the email", async () => {
    const sent = stubFetch(200, {})
    const onSuccess = vi.fn()
    const renderer = render(<ForgotPasswordForm redirectTo="https://app.example/reset" onSuccess={onSuccess} />)
    type(renderer, "st-forgot-email", "ada@example.com")
    await submit(renderer)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe("POST")
    expect(sent[0]!.url.pathname).toBe("/auth/v1/recover")
    expect(sent[0]!.url.searchParams.get("redirect_to")).toBe("https://app.example/reset")
    expect(sent[0]!.body).toEqual({ email: "ada@example.com" })
    expect(onSuccess).toHaveBeenCalledWith("ada@example.com")
    expect(textOf(renderer.root.findByProps({ role: "status" }))).toBe("Check your email for the password reset link.")
  })

  it("shows the server's refusal, calls onError and keeps the form", async () => {
    stubFetch(429, { code: 429, error_code: "over_email_send_rate_limit", msg: "Email rate limit exceeded" })
    const onError = vi.fn()
    const renderer = render(<ForgotPasswordForm onError={onError} classNames={CLASS_NAMES} />)
    type(renderer, "st-forgot-email", "ada@example.com")
    await submit(renderer)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Email rate limit exceeded", code: "over_email_send_rate_limit" }))
    const alert = renderer.root.findByProps({ role: "alert" })
    expect(textOf(alert)).toBe("Email rate limit exceeded")
    expect(alert.props["className"]).toBe("t-error")
    expect(renderer.root.findAllByType("form")).toHaveLength(1)
  })

  it("puts each slot's class on the element it names, the message included", async () => {
    stubFetch(200, {})
    const renderer = render(<ForgotPasswordForm className="t-form" classNames={CLASS_NAMES} />)
    const root = renderer.root
    expect(classesOf(root, "form")).toEqual(["t-form"])
    expect(classesOf(root, "h2")).toEqual(["t-title"])
    expect(classesOf(root, "div")).toEqual(["t-field"])
    expect(classesOf(root, "label")).toEqual(["t-label"])
    expect(classesOf(root, "input")).toEqual(["t-input"])
    expect(classesOf(root, "button")).toEqual(["t-submit"])
    type(renderer, "st-forgot-email", "ada@example.com")
    await submit(renderer)
    expect(root.findByProps({ role: "status" }).props["className"]).toBe("t-message")
  })
})

describe("labels", () => {
  it("replaces a default with the app's label and keeps one the app leaves undefined", () => {
    const root = render(<ForgotPasswordForm labels={{ title: undefined, submit: "Email me a reset link" }} />).root
    expect(textOf(root.findByType("h2"))).toBe("Reset your password")
    expect(textOf(root.findByType("button"))).toBe("Email me a reset link")
  })
})

describe("MagicLinkForm", () => {
  it("asks /otp for a sign-in link that returns to redirectTo, then says to check the email", async () => {
    const sent = stubFetch(200, {})
    const onSuccess = vi.fn()
    const renderer = render(<MagicLinkForm redirectTo="https://app.example/" onSuccess={onSuccess} />)
    type(renderer, "st-magic-email", "ada@example.com")
    await submit(renderer)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe("POST")
    expect(sent[0]!.url.pathname).toBe("/auth/v1/otp")
    expect(sent[0]!.url.searchParams.get("redirect_to")).toBe("https://app.example/")
    expect(sent[0]!.body).toEqual({ email: "ada@example.com", create_user: true })
    expect(onSuccess).toHaveBeenCalledWith("ada@example.com")
    expect(textOf(renderer.root.findByProps({ role: "status" }))).toBe("Check your email for the magic link.")
  })

  it("shows the server's refusal and calls onError", async () => {
    stubFetch(422, { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" })
    const onError = vi.fn()
    const renderer = render(<MagicLinkForm onError={onError} />)
    type(renderer, "st-magic-email", "ada@example.com")
    await submit(renderer)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "otp_disabled" }))
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Signups not allowed for otp")
  })

  it("puts each slot's class on the element it names", () => {
    const root = render(<MagicLinkForm className="t-form" classNames={CLASS_NAMES} />).root
    expect(classesOf(root, "form")).toEqual(["t-form"])
    expect(classesOf(root, "h2")).toEqual(["t-title"])
    expect(classesOf(root, "label")).toEqual(["t-label"])
    expect(classesOf(root, "input")).toEqual(["t-input"])
    expect(classesOf(root, "button")).toEqual(["t-submit"])
  })
})

describe("UpdatePasswordForm", () => {
  it("sets the new password with PUT /user on the recovery session, then says it is updated", async () => {
    const sent = stubFetch(200, USER)
    const onSuccess = vi.fn()
    const renderer = render(<UpdatePasswordForm onSuccess={onSuccess} />, RECOVERY_SESSION)
    type(renderer, "st-update-password", "a-new-password")
    await submit(renderer)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe("PUT")
    expect(sent[0]!.url.pathname).toBe("/auth/v1/user")
    expect(sent[0]!.authorization).toBe("Bearer recovery-access-token")
    expect(sent[0]!.body).toEqual({ password: "a-new-password" })
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ id: "user-1", email: "ada@example.com" }))
    expect(textOf(renderer.root.findByProps({ role: "status" }))).toBe("Your password has been updated.")
  })

  it("shows the server's refusal and calls onError", async () => {
    stubFetch(422, { code: 422, error_code: "weak_password", msg: "Password should be at least 8 characters." })
    const onError = vi.fn()
    const renderer = render(<UpdatePasswordForm onError={onError} />, RECOVERY_SESSION)
    type(renderer, "st-update-password", "short")
    await submit(renderer)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "weak_password" }))
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Password should be at least 8 characters.")
  })

  it("says so without a request when there is no session to update", async () => {
    const sent = stubFetch(200, USER)
    const onError = vi.fn()
    const renderer = render(<UpdatePasswordForm onError={onError} />)
    type(renderer, "st-update-password", "a-new-password")
    await submit(renderer)

    expect(sent).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Not authenticated" }))
  })

  it("puts each slot's class on the element it names", () => {
    const root = render(<UpdatePasswordForm className="t-form" classNames={CLASS_NAMES} />, RECOVERY_SESSION).root
    expect(classesOf(root, "form")).toEqual(["t-form"])
    expect(classesOf(root, "h2")).toEqual(["t-title"])
    expect(classesOf(root, "label")).toEqual(["t-label"])
    expect(classesOf(root, "input")).toEqual(["t-input"])
    expect(classesOf(root, "button")).toEqual(["t-submit"])
  })
})
