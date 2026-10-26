// @vitest-environment jsdom
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { act, actScopeOpenIn, actScopesClosed, isolateEachTest, settle } from "./support.js"

/**
 * isolateEachTest waits for any act a test left open by reading React's internal act queue. These
 * pin what that read does when the internals are there, and that it fails loudly when a React
 * upgrade moves them, rather than quietly waiting for nothing.
 */

const INTERNALS = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"

isolateEachTest()

describe("reading whether an act is open", () => {
  it("sees React's act queue open inside an act and closed outside one", async () => {
    expect(actScopeOpenIn(React)).toBe(false)
    let inside = false
    await act(() => { inside = actScopeOpenIn(React) })
    expect(inside).toBe(true)
  })

  it("throws when React has no internals object", () => {
    expect(() => actScopeOpenIn({})).toThrow("React's internals hold no act queue")
  })

  it("throws when React's internals hold no act queue", () => {
    expect(() => actScopeOpenIn({ [INTERNALS]: {} })).toThrow("React's internals hold no act queue")
  })
})

describe("waiting for open acts to close", () => {
  it("gives up after its deadline, naming the test that left the act open", async () => {
    const stuck = { [INTERNALS]: { actQueue: [] } }
    await expect(actScopesClosed(stuck, 20)).rejects.toThrow(
      '"waiting for open acts to close > gives up after its deadline, naming the test that left the act open" left an act open that did not close within 20ms',
    )
  })
})

describe("settling", () => {
  it("names the setup call it needs when the clock is not virtual", async () => {
    vi.useRealTimers()
    await expect(settle()).rejects.toThrow("call isolateEachTest() at the top of this test file")
  })
})
