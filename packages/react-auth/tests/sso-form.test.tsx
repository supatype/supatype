/**
 * SSOForm, over the real client: the request the auth server receives for what the user typed, where
 * the browser goes, and what the form shows while it waits and when it is refused.
 */

import React from "react"
import { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SSOForm } from "../src/index.js"
import { render, stubBrowser, stubFetch, submit, textOf, type } from "./helpers.js"
import { fire } from "./props.js"

const IDP_URL = "https://idp.example/sso?SAMLRequest=abc"
const PROVIDER_KEY = "supatype.auth.session-oauth-provider"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("SSOForm", () => {
  it("starts SSO for the domain of the email typed and sends the browser to the identity provider", async () => {
    const { assign } = stubBrowser()
    const sent = stubFetch(200, { url: IDP_URL })
    const onSuccess = vi.fn()
    const renderer = render(<SSOForm redirectTo="https://app.example/home" onSuccess={onSuccess} />)
    type(renderer, "st-sso-email", " Ada@Acme.COM ")
    await submit(renderer)

    const sso = sent.find((r) => r.url.pathname === "/auth/v1/sso")
    expect(sso?.method).toBe("POST")
    expect(sso?.body).toEqual({ domain: "acme.com", skip_http_redirect: true, redirect_to: "https://app.example/home" })
    expect(assign).toHaveBeenCalledWith(IDP_URL)
    expect(onSuccess).toHaveBeenCalledWith(IDP_URL)
    expect(textOf(renderer.root.findByProps({ role: "status" }))).toBe("Redirecting to your identity provider…")
  })

  it("takes a bare domain as it is", async () => {
    stubBrowser()
    const sent = stubFetch(200, { url: IDP_URL })
    const renderer = render(<SSOForm />)
    type(renderer, "st-sso-email", "acme.com")
    await submit(renderer)

    expect(sent.find((r) => r.url.pathname === "/auth/v1/sso")?.body).toEqual({ domain: "acme.com", skip_http_redirect: true })
  })

  it("refuses an address with no domain without asking the server", async () => {
    stubBrowser()
    const sent = stubFetch(200, { url: IDP_URL })
    const onError = vi.fn()
    const renderer = render(<SSOForm onError={onError} />)
    type(renderer, "st-sso-email", "ada@")
    await submit(renderer)

    expect(sent.filter((r) => r.url.pathname === "/auth/v1/sso")).toHaveLength(0)
    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("Enter your work email address.")
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "validation_failed" }))
  })

  it("shows the server's refusal, calls onError, keeps the form and stays on the page", async () => {
    const { assign } = stubBrowser()
    stubFetch(404, { code: 404, error_code: "sso_provider_not_found", msg: "No SSO provider assigned for this domain" })
    const onError = vi.fn()
    const renderer = render(<SSOForm onError={onError} />)
    type(renderer, "st-sso-email", "ada@nope.com")
    await submit(renderer)

    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("No SSO provider assigned for this domain")
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "sso_provider_not_found" }))
    expect(renderer.root.findAllByType("form")).toHaveLength(1)
    expect(assign).not.toHaveBeenCalled()
  })

  it("disables the field and button and says it is redirecting while the request runs", async () => {
    stubBrowser()
    let answer: (res: Response) => void = () => undefined
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve })))
    const renderer = render(<SSOForm />)
    type(renderer, "st-sso-email", "ada@acme.com")
    const form = renderer.root.findByType("form")
    act(() => { void fire(form, "onSubmit", { preventDefault: () => undefined }) })

    const button = renderer.root.findByType("button")
    expect(button.props["disabled"]).toBe(true)
    expect(textOf(button)).toBe("Redirecting…")
    expect(renderer.root.findByType("input").props["disabled"]).toBe(true)
    await act(async () => { answer(new Response(JSON.stringify({ url: IDP_URL }), { status: 200 })) })
  })

  it("shows an SSO sign-in the auth server refused and sent back in the URL", async () => {
    stubFetch(200, {})
    stubBrowser(
      "https://app.example/login#error=access_denied&error_description=An+account+with+this+email+already+exists",
      { [PROVIDER_KEY]: "sso" },
    )
    const onError = vi.fn()
    const renderer = render(<SSOForm onError={onError} />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toBe("An account with this email already exists")
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ provider: "sso", code: "access_denied" }))
  })
})
