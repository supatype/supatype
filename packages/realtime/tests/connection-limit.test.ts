import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { RealtimeServer } from "../src/server.js"
import { connect, freePort, serviceToken, testEnv, userToken, type Peer } from "./fixtures/socket.js"

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
  const body = (await res.json()) as { data: { limit: unknown; total: number } }
  return body.data
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
    const port = await freePort()
    const adminPort = await freePort()
    server = new RealtimeServer(testEnv(port, { adminPort, connectionLimit: 2 }))
    await server.start()

    peers.push(await connect(port, userToken("a")), await connect(port, userToken("b")))
    const third = await connect(port, userToken("c"))
    peers.push(third)

    expect(await closeCode(third)).toBe(4429)
    expect(await connectionsLimit(adminPort)).toMatchObject({ limit: 2, total: 2 })
  })

  it("lets everyone in when unset, and reports no limit", async () => {
    const port = await freePort()
    const adminPort = await freePort()
    server = new RealtimeServer(testEnv(port, { adminPort }))
    await server.start()

    for (let i = 0; i < 50; i++) peers.push(await connect(port, userToken(`u${i}`)))

    expect(peers.every((p) => p.ws.readyState === WebSocket.OPEN)).toBe(true)
    expect(await connectionsLimit(adminPort)).toMatchObject({ limit: null, total: 50 })
  })
})
