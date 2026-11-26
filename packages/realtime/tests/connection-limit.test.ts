import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { RealtimeServer } from "../src/server.js"
import { expectObject } from "./fixtures/expect-json.js"
import { connect, serviceToken, ANY_PORT, testEnv, userToken, type Peer } from "./fixtures/socket.js"
import { undeclaredChannels } from "./fixtures/fake-channel-db.js"

/**
 * `CONNECTION_LIMIT` in single-tenant mode, which is how every Cloud project's own realtime runs.
 *
 * The tier limits were enforced only in multi-tenant mode, which Cloud does not use, so no Cloud
 * project had any limit at all. Self-host leaves it unset and has none.
 */

function closeCode(peer: Peer): Promise<number> {
  return new Promise((resolve) => {
    if (peer.ws.readyState === WebSocket.CLOSED) resolve(-1)
    peer.ws.once("close", (code) => resolve(code))
  })
}

async function connectionsLimit(adminPort: number): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${adminPort}/admin/v1/connections`, {
    headers: { Authorization: `Bearer ${serviceToken()}` },
  })
  return expectObject(expectObject(await res.json())["data"])
}

describe("CONNECTION_LIMIT", () => {
  const peers: Peer[] = []
  let server: RealtimeServer | null = null

  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.close()
    await server?.stop()
    server = null
  })

  it("closes the socket past the limit with 4429, and reports the limit", async () => {
    server = new RealtimeServer(testEnv(ANY_PORT, { adminPort: ANY_PORT, connectionLimit: 2 }), { channelDb: undeclaredChannels() })
    await server.start()
    const port = server.port
    const adminPort = server.adminPort ?? 0

    peers.push(await connect(port, userToken("a")), await connect(port, userToken("b")))
    const third = await connect(port, userToken("c"))
    peers.push(third)

    expect(await closeCode(third)).toBe(4429)
    expect(await connectionsLimit(adminPort)).toMatchObject({ limit: 2, total: 2 })
  })

  it("lets everyone in when unset, and reports no limit", async () => {
    server = new RealtimeServer(testEnv(ANY_PORT, { adminPort: ANY_PORT }), { channelDb: undeclaredChannels() })
    await server.start()
    const port = server.port
    const adminPort = server.adminPort ?? 0

    for (let i = 0; i < 50; i++) peers.push(await connect(port, userToken(`u${i}`)))

    expect(peers.every((p) => p.ws.readyState === WebSocket.OPEN)).toBe(true)
    expect(await connectionsLimit(adminPort)).toMatchObject({ limit: null, total: 50 })
  })

  it("binds ports the OS chose, one pair per server, so parallel suites cannot collide", async () => {
    const other = new RealtimeServer(testEnv(ANY_PORT, { adminPort: ANY_PORT }), { channelDb: undeclaredChannels() })
    server = new RealtimeServer(testEnv(ANY_PORT, { adminPort: ANY_PORT }), { channelDb: undeclaredChannels() })
    try {
      await server.start()
      await other.start()
      const ports = [server.port, server.adminPort, other.port, other.adminPort]
      expect(ports.every((p) => typeof p === "number" && p > 0)).toBe(true)
      expect(new Set(ports).size).toBe(4)
    } finally {
      await other.stop()
    }
  })
})
