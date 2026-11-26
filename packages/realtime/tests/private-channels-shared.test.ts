import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RealtimeServer } from "../src/server.js"
import type { WalChange } from "../src/types.js"
import { SECRET, connect, settle, ANY_PORT, testEnv, userToken, type Peer } from "./fixtures/socket.js"
import { FakeChannelDb, LOT_ID } from "./fixtures/fake-channel-db.js"

/**
 * A shared realtime instance serves many projects off one database, and the channel functions are
 * one set per database, so none of them can answer for one project (plan P7). It must not pretend to:
 * a join that asks for privacy is refused, nothing declared is enforced, and it never asks.
 */

const PROJECT = "proj-a"
const ALICE = "11111111-1111-4111-8111-111111111111"

describe("private channels on a shared instance", () => {
  let routes: Server
  let server: RealtimeServer
  let port: number
  const db = new FakeChannelDb()
  const peers: Peer[] = []

  beforeAll(async () => {
    routes = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ routes: [{ ref: PROJECT, jwtSecret: SECRET, tier: "free", status: "active" }] }))
    })
    await new Promise<void>((resolve) => routes.listen(ANY_PORT, "127.0.0.1", resolve))
    const bound = routes.address()
    if (bound === null || typeof bound === "string") throw new Error("the routes server is not listening")
    const routesPort = bound.port
    server = new RealtimeServer(
      testEnv(ANY_PORT, { multiTenant: true, routingTableUrl: `http://127.0.0.1:${routesPort}/routes`, connectionLimits: { free: 50 } }),
      { channelDb: db },
    )
    await server.start()
    port = server.port
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server.stop()
    await new Promise<void>((resolve) => routes.close(() => resolve()))
  })

  const open = async (): Promise<Peer> => {
    const peer = await connect(port, userToken(ALICE), `project=${PROJECT}`)
    peers.push(peer)
    return peer
  }

  it("refuses a join opened as private, saying it cannot be done here", async () => {
    const peer = await open()

    peer.send({ type: "subscribe", channel: `lot:${LOT_ID}`, private: true, ref: "p1" })
    const answer = await peer.next((m) => m.type === "system" && m.ref === "p1")

    expect(answer).toMatchObject({
      status: "error",
      channel: `lot:${LOT_ID}`,
      code: "shared_instance",
      message: "private channels are not available on a shared realtime instance",
    })
  })

  it("leaves a join that does not ask for privacy as it always was, and asks the database nothing", async () => {
    const a = await open()
    const b = await open()
    a.send({ type: "subscribe", channel: "room-1", ref: "a1" })
    await a.next((m) => m.type === "system" && m.ref === "a1" && m.status === "ok")
    b.send({ type: "subscribe", channel: "room-1", ref: "b1" })
    await b.next((m) => m.type === "system" && m.ref === "b1" && m.status === "ok")

    a.send({ type: "broadcast", channel: "room-1", event: "hi", payload: {} })
    const heard = await b.next((m) => m.type === "broadcast")

    expect(heard).toMatchObject({ event: "hi" })
    expect(db.callerSessions + db.serviceSessions).toBe(0)
  })

  it("does not deliver a database broadcast, which is part of what is not available here", async () => {
    const a = await open()
    a.send({ type: "subscribe", channel: "room-2", ref: "o1" })
    await a.next((m) => m.type === "system" && m.ref === "o1" && m.status === "ok")
    const row: WalChange = {
      schema: "_supatype",
      table: "realtime_outbox",
      event: "INSERT",
      newRecord: { id: "1", topic: "room-2", event: "x", payload: {} },
      oldRecord: null,
      exactColumns: {},
      columnTypes: {},
      commitTimestamp: "2026-11-14T10:00:00+00:00",
    }

    await server.dispatchChange(row)
    await settle(a)

    expect(a.frames.some((m) => m.type === "broadcast")).toBe(false)
  })
})
