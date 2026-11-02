import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import jwt from "jsonwebtoken"
import { RealtimeServer } from "../src/server.js"
import { SECRET, connect, freePort, isSystem, settle, testEnv, type Peer } from "./fixtures/socket.js"

/**
 * A socket's identity lasts as long as the token it proved it with.
 *
 * The token was verified at the upgrade and on an `auth` message and never looked at again, so a
 * socket opened with a token that expired, or whose user was signed out, kept receiving every
 * change that user could see for as long as it stayed open. The server now closes it at the
 * token's `exp` with 4401, unless a fresh token arrives first.
 */

const TOKEN_EXPIRED = 4401

/** A user token expiring `seconds` from now, by the real clock the verifier reads. */
function tokenFor(seconds: number): string {
  return jwt.sign({ sub: "expiring-user", role: "authenticated", aud: "authenticated" }, SECRET, { expiresIn: seconds })
}

/** The close code and reason the server closes `peer` with. */
function closed(peer: Peer): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    peer.ws.once("close", (code, reason) => resolve({ code, reason: String(reason) }))
  })
}

describe("an authenticated socket", () => {
  let server: RealtimeServer
  let port: number
  const peers: Peer[] = []

  beforeAll(async () => {
    port = await freePort()
    server = new RealtimeServer(testEnv(port))
    await server.start()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server.stop()
  })

  /**
   * The clock and the timers the expiry is scheduled with, starting from now; the sockets keep
   * their real I/O. Tokens are signed and verified before the clock is moved.
   */
  const fakeTimers = (): void => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() })
  }

  it("is closed with 4401 when its token expires", async () => {
    fakeTimers()
    const peer = await connect(port, tokenFor(600))
    peers.push(peer)
    await peer.next(isSystem("ok", "authenticated"))
    const closing = closed(peer)

    vi.advanceTimersByTime(599_000)
    await settle(peer)
    vi.advanceTimersByTime(2_000)

    expect(await closing).toEqual({ code: TOKEN_EXPIRED, reason: "token expired" })
  })

  it("stays open past the first token's expiry once a fresher one is sent", async () => {
    fakeTimers()
    const peer = await connect(port, tokenFor(600))
    peers.push(peer)
    await peer.next(isSystem("ok", "authenticated"))
    peer.send({ type: "auth", token: tokenFor(1200) })
    await peer.next((m) => isSystem("ok", "authenticated")(m) && peer.frames.filter(isSystem("ok", "authenticated")).length >= 2)
    const closing = closed(peer)

    vi.advanceTimersByTime(601_000)
    await settle(peer)
    expect(peer.ws.readyState).toBe(peer.ws.OPEN)

    vi.advanceTimersByTime(600_000)
    expect((await closing).code).toBe(TOKEN_EXPIRED)
  })

  it("leaves no expiry timer behind once it disconnects", async () => {
    fakeTimers()
    const before = vi.getTimerCount()
    const peer = await connect(port, tokenFor(600))
    await peer.next(isSystem("ok", "authenticated"))
    expect(vi.getTimerCount()).toBeGreaterThan(before)

    const gone = closed(peer)
    peer.close()
    await gone
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(before), { interval: 5 })
  })
})
