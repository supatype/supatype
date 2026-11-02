import { connect as netConnect } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadEnv } from "../src/env.js"
import { RealtimeServer } from "../src/server.js"
import { freePort, testEnv } from "./fixtures/socket.js"

/**
 * Local test round 3c (N18): native dev's realtime listened on `0.0.0.0` and `[::]`, every address
 * the machine has, while the server, PostgREST, the worker and the storage service listen on
 * 127.0.0.1 only. `REALTIME_HOST` names the address; unset, it listens on every one, as in its
 * container.
 */

/** Whether something accepts a connection on `host:port`. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

describe("REALTIME_HOST", () => {
  let server: RealtimeServer | null = null

  afterEach(async () => {
    vi.unstubAllEnvs()
    await server?.stop()
    server = null
  })

  it("is read from the environment, and unset means every address", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://nobody@127.0.0.1:1/none")
    vi.stubEnv("JWT_SECRET", "secret")
    vi.stubEnv("REALTIME_HOST", undefined)
    expect(loadEnv().host).toBeUndefined()
    vi.stubEnv("REALTIME_HOST", " 127.0.0.1 ")
    expect(loadEnv().host).toBe("127.0.0.1")
  })

  it("listens on that address only, the admin API too", async () => {
    const port = await freePort()
    const adminPort = await freePort()
    server = new RealtimeServer(testEnv(port, { adminPort, host: "127.0.0.1" }))
    await server.start()

    expect(await accepts("127.0.0.1", port)).toBe(true)
    expect(await accepts("127.0.0.1", adminPort)).toBe(true)
    // Listening on every address takes IPv6 loopback as well.
    expect(await accepts("::1", port)).toBe(false)
    expect(await accepts("::1", adminPort)).toBe(false)
  })

  it("listens on every address when none is named", async () => {
    const port = await freePort()
    server = new RealtimeServer(testEnv(port))
    await server.start()

    expect(await accepts("127.0.0.1", port)).toBe(true)
    expect(await accepts("::1", port)).toBe(true)
  })
})
