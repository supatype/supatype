import { vi, describe, it, expect, afterEach } from "vitest"
import { createClient, type AnyDatabase, type AuthRedirectError, type SupatypeClient } from "@supatype/client"

/**
 * What every framework binding's auth primitive owes a component unmounted while the client is
 * still starting: no auth listener left behind.
 *
 * Vue's and Solid's subscribed only after awaiting start-up, so an unmount in that window ran its
 * cleanup before there was anything to clean up, and the listener stayed for the life of the
 * client. Shared by the Vue, Svelte and Solid suites over a real client, built from the package the
 * bindings import. Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface ListenerCount {
  subscribed: number
  unsubscribed: number
}

/** Counts every auth listener the client hands out and every one given back. */
function countListeners(client: SupatypeClient<AnyDatabase>): ListenerCount {
  const count: ListenerCount = { subscribed: 0, unsubscribed: 0 }
  const subscribe = client.auth.onAuthStateChange.bind(client.auth)
  vi.spyOn(client.auth, "onAuthStateChange").mockImplementation((listener) => {
    const handed = subscribe(listener)
    count.subscribed += 1
    const unsubscribe = handed.data.subscription.unsubscribe.bind(handed.data.subscription)
    vi.spyOn(handed.data.subscription, "unsubscribe").mockImplementation(() => {
      count.unsubscribed += 1
      unsubscribe()
    })
    return handed
  })
  return count
}

export function describeAuthUnmountBinding(
  name: string,
  mount: (client: SupatypeClient<AnyDatabase>) => void,
  unmount: () => void,
): void {
  describe(`${name} unmounted while the client is starting`, () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("leaves no auth listener behind", async () => {
      const client = createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" })
      let started: (value: { error: AuthRedirectError | null }) => void = () => undefined
      vi.spyOn(client.auth, "initialize").mockReturnValue(new Promise((resolve) => { started = resolve }))
      const count = countListeners(client)

      mount(client)
      await settle()
      unmount()
      started({ error: null })
      await settle()

      expect(count.subscribed).toBeGreaterThan(0)
      expect(count.unsubscribed).toBe(count.subscribed)
    })
  })
}
