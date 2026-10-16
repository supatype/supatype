import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestInstance } from "react-test-renderer"
import type { AuthRedirectError, SupatypeError } from "@supatype/client"
import { OAuthButton } from "../src/index.js"

type OAuthResult = { data: { url: string; provider: string }; error: SupatypeError | null }

const auth = vi.hoisted(() => ({
  error: null as AuthRedirectError | null,
  signInWithOAuth: vi.fn<(opts: { provider: string }) => Promise<OAuthResult>>(),
}))

vi.mock("@supatype/react", () => ({
  useAuth: () => ({ error: auth.error, signInWithOAuth: auth.signInWithOAuth }),
}))

/** The text a screen reader announces for the button: its aria-label when set, else its content. */
function accessibleName(button: ReactTestInstance): string {
  const label = button.props["aria-label"] as string | undefined
  if (label !== undefined) return label
  return button.children.filter((child): child is string => typeof child === "string").join("")
}

afterEach(() => {
  auth.error = null
  auth.signInWithOAuth.mockReset()
  vi.unstubAllGlobals()
})

describe("OAuthButton accessible name", () => {
  it("is the visible label an app gives it", () => {
    const button = create(<OAuthButton provider="keycloak">Sign in with Mock SSO</OAuthButton>).root.findByType("button")
    expect(accessibleName(button)).toBe("Sign in with Mock SSO")
  })

  it("is the default label, spelled the way the provider spells itself", () => {
    const button = create(<OAuthButton provider="github" />).root.findByType("button")
    expect(accessibleName(button)).toBe("Sign in with GitHub")
  })
})

describe("OAuthButton errors", () => {
  it("calls onError and stays on the page when the provider is not enabled", async () => {
    const location = { href: "https://app.example/" }
    vi.stubGlobal("window", { location })
    const error = { message: "Sign-in with github is not enabled for this project.", code: "provider_disabled" }
    auth.signInWithOAuth.mockResolvedValue({ data: { url: "", provider: "github" }, error })
    const onError = vi.fn()

    const button = create(<OAuthButton provider="github" onError={onError} />).root.findByType("button")
    await act(async () => { (button.props["onClick"] as () => void)() })

    expect(onError).toHaveBeenCalledWith(error)
    expect(location.href).toBe("https://app.example/")
  })

  it("reports a refusal the server sent back in the URL to the button that started it", async () => {
    auth.error = { message: "Signups not allowed", code: "signup_disabled", provider: "github" }
    const onGitHub = vi.fn()
    const onGoogle = vi.fn()

    await act(async () => {
      create(<>
        <OAuthButton provider="github" onError={onGitHub} />
        <OAuthButton provider="google" onError={onGoogle} />
      </>)
    })

    expect(onGitHub).toHaveBeenCalledTimes(1)
    expect(onGitHub).toHaveBeenCalledWith(auth.error)
    expect(onGoogle).not.toHaveBeenCalled()
  })
})
