/**
 * An auth deep link whose exchange throws instead of answering `{ data, error }` reaches `onError`,
 * reported once to the console, rather than becoming an unhandled rejection nobody hears.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthClient } from "@supatype/client"
import { createAuthUrlListener, type LinkingLike } from "../src/index.js"

class SetupFault extends Error {
  constructor() {
    super("Supatype client has no API address")
    this.name = "SetupFault"
  }
}

function linkingWith(initialUrl: string | null): { module: LinkingLike; open(url: string): void } {
  let handler: ((event: { url: string }) => void) | null = null
  return {
    module: {
      addEventListener: (_type, h) => {
        handler = h
        return { remove: vi.fn() }
      },
      getInitialURL: async () => initialUrl,
    },
    open: (url) => handler?.({ url }),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createAuthUrlListener when the exchange throws", () => {
  it("hands the thrown error to onError and reports it once per link", async () => {
    const thrown = new SetupFault()
    const auth = new AuthClient("http://localhost:9999/auth/v1", { apikey: "anon" })
    vi.spyOn(auth, "getSessionFromUrl").mockRejectedValue(thrown)
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const onError = vi.fn()
    const link = linkingWith("myapp://auth/callback?code=cold")

    const unsubscribe = createAuthUrlListener({ auth }, { linking: link.module, onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    link.open("myapp://auth/callback?code=warm")
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2))

    expect(onError.mock.calls).toEqual([[thrown], [thrown]])
    expect(logged.mock.calls.filter((call) => call.includes(thrown))).toHaveLength(2)
    unsubscribe()
  })
})
