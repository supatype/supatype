import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { AuthClient } from "../../src/auth.js"
import type { Session, SupatypeError, User } from "../../src/types.js"

/**
 * What every framework binding's auth primitive owes a sign-up that waits for email confirmation.
 *
 * The auth server answers such a sign-up with the bare user and no tokens. The binding must stay
 * signed out and hand the caller what it needs to say "check your email". Shared by the Vue,
 * Svelte and Solid suites over a real AuthClient, so the client's answer is what is under test.
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export type SignUpBindingResult = {
  data: { session: Session | null; user: User | null }
  error: SupatypeError | null
}

export interface SignUpBindingProbe {
  user(): User | null | undefined
  signUp(email: string, password: string): Promise<SignUpBindingResult>
}

const PENDING_USER = {
  id: "user-pending",
  email: "ada@example.com",
  confirmation_sent_at: "2024-01-01T00:00:00Z",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function describeSignUpBinding(
  name: string,
  mount: (auth: AuthClient) => SignUpBindingProbe,
  unmount: () => void,
): void {
  describe(`${name} sign-up waiting for email confirmation`, () => {
    let probe: SignUpBindingProbe

    beforeEach(async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(PENDING_USER),
        headers: { get: () => null },
      }))
      probe = mount(new AuthClient("http://localhost:9999/auth/v1", { apikey: "anon" }))
      await settle()
    })
    afterEach(() => {
      unmount()
      vi.unstubAllGlobals()
    })

    it("stays signed out", async () => {
      await probe.signUp("ada@example.com", "secret")
      await settle()

      expect(probe.user()).toBeNull()
    })

    it("returns the user and no session, so the app can ask for the confirmation", async () => {
      const { data, error } = await probe.signUp("ada@example.com", "secret")

      expect(error).toBeNull()
      expect(data.session).toBeNull()
      expect(data.user?.id).toBe("user-pending")
    })
  })
}
