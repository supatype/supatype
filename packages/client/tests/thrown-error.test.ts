/**
 * `reportThrown`: what a binding holds as `error` for a request that threw, and the one console
 * line that says so.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { reportThrown } from "../src/thrown-error.js"
import { MissingClientValuesError, NetworkError, RateLimitError, SupatypeError } from "../src/errors.js"

afterEach(() => {
  vi.restoreAllMocks()
})

function quietly(thrown: unknown): ReturnType<typeof reportThrown> {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  return reportThrown("useQuery(\"posts\")", thrown)
}

describe("reportThrown", () => {
  it("names the hook and carries the thrown value on one console line", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const thrown = new Error("no address")
    reportThrown("useQuery(\"posts\")", thrown)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith("[supatype] useQuery(\"posts\"): the request threw.", thrown)
  })

  it("keeps one of the SDK's own errors as it is, so instanceof still names it", () => {
    const thrown = new MissingClientValuesError("no address", ["url"])
    expect(quietly(thrown)).toBe(thrown)
  })

  it("holds any other Error as the cause of a SupatypeError with its message", () => {
    const thrown = new Error("no address")
    const held = quietly(thrown)
    expect(held).toBeInstanceOf(SupatypeError)
    expect((held as Error).cause).toBe(thrown)
    expect({ ...(held as object) }).toEqual({ message: "no address" })
  })

  it("gives the SDK's own errors the JSON a failed request answers with", () => {
    expect(JSON.parse(JSON.stringify(quietly(new RateLimitError(3))))).toEqual({
      message: "Rate limited. Retry after 3 seconds.",
      code: "RATE_LIMITED",
      status: 429,
    })
    expect({ ...quietly(new NetworkError("offline")) }).toEqual({ message: "offline", code: "NETWORK_ERROR" })
  })

  it("wraps an Error whose fields do not fit, keeping its message", () => {
    const thrown = Object.assign(new Error("socket hang up"), { code: 104 })
    expect({ ...quietly(thrown) }).toEqual({ message: "socket hang up" })
  })

  it("wraps a thrown string or anything else", () => {
    expect({ ...quietly("bad thing") }).toEqual({ message: "bad thing" })
    expect({ ...quietly({ nope: true }) }).toEqual({ message: "Unknown error" })
  })
})
