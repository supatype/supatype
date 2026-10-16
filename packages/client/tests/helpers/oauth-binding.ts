import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import type { AuthRedirectError, Session, SupatypeError } from "../../src/types.js"

/**
 * What every framework binding's auth primitive owes an OAuth sign-in.
 *
 * Shared by the Vue, Svelte and Solid suites, because each must start the redirect and surface the
 * server's refusal the same way; a copy per binding would let one drift. Not named `*.test.ts`, so
 * vitest's default include does not collect it as a suite.
 */
type OAuthResult = { data: { url: string; provider: string }; error: SupatypeError | null }

export interface OAuthBindingHarness {
  auth: {
    initialize: () => Promise<{ error: AuthRedirectError | null }>
    getSession: () => Promise<{ data: { session: Session | null }; error: null }>
    onAuthStateChange: () => { data: { subscription: { unsubscribe(): void } } }
    signInWithOAuth: ReturnType<typeof vi.fn<(opts: { provider: string }) => Promise<OAuthResult>>>
  }
  /** The refusal the next mount's `initialize()` reports. */
  redirectError: AuthRedirectError | null
}

export interface OAuthBindingProbe {
  error(): AuthRedirectError | null | undefined
  signInWithOAuth(provider: string): Promise<{ error: SupatypeError | null }>
}

function createHarness(): OAuthBindingHarness {
  const harness: OAuthBindingHarness = {
    redirectError: null,
    auth: {
      initialize: () => Promise.resolve({ error: harness.redirectError }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      signInWithOAuth: vi.fn<(opts: { provider: string }) => Promise<OAuthResult>>(),
    },
  }
  return harness
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function describeOAuthBinding(
  name: string,
  mount: (harness: OAuthBindingHarness) => OAuthBindingProbe,
  unmount: () => void,
): void {
  describe(`${name} OAuth`, () => {
    let harness: OAuthBindingHarness
    let assign: ReturnType<typeof vi.fn<(url: string) => void>>

    beforeEach(() => {
      harness = createHarness()
      assign = vi.fn<(url: string) => void>()
      vi.stubGlobal("window", { location: { href: "https://app.example/", assign } })
    })
    afterEach(() => {
      unmount()
      vi.unstubAllGlobals()
    })

    it("sends the browser to the provider", async () => {
      const url = "http://localhost:9999/auth/v1/authorize?provider=github"
      harness.auth.signInWithOAuth.mockResolvedValue({ data: { url, provider: "github" }, error: null })

      const { error } = await mount(harness).signInWithOAuth("github")

      expect(error).toBeNull()
      expect(assign).toHaveBeenCalledWith(url)
    })

    it("stays on the page and returns the error when the provider is not enabled", async () => {
      const refusal = { message: "Sign-in with github is not enabled for this project.", code: "provider_disabled" }
      harness.auth.signInWithOAuth.mockResolvedValue({ data: { url: "", provider: "github" }, error: refusal })

      const { error } = await mount(harness).signInWithOAuth("github")

      expect(error).toEqual(refusal)
      expect(assign).not.toHaveBeenCalled()
    })

    it("exposes a refusal the server sent back in the URL", async () => {
      harness.redirectError = { message: "Signups not allowed", code: "signup_disabled", provider: "github" }

      const probe = mount(harness)
      await settle()

      expect(probe.error()).toEqual(harness.redirectError)
    })
  })
}
