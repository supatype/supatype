import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RealtimeServer } from "../src/server.js"
import { connect, freePort, isSystem, settle, testEnv, userToken, type Peer } from "./fixtures/socket.js"

/**
 * A subscribe whose filter the server cannot read is refused, naming the condition.
 *
 * It used to be accepted, and the unreadable condition skipped when matching, so a typo such as
 * `status=like.open` or `id=in.(1,2)` widened the subscription to every row of the table while
 * the socket reported SUBSCRIBED.
 */

describe("a subscribe filter", () => {
  let server: RealtimeServer
  let port: number
  const peers: Peer[] = []
  const open = async (): Promise<Peer> => {
    const peer = await connect(port, userToken("filter-user"))
    peers.push(peer)
    return peer
  }

  beforeAll(async () => {
    port = await freePort()
    server = new RealtimeServer(testEnv(port))
    await server.start()
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server.stop()
  })

  it("with a condition the grammar does not know is refused, and joins nothing", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", channel: "orders", table: "orders", filter: { id: "eq.1", status: "like.open" } })

    const refusal = await peer.next(isSystem("error"))
    expect(refusal).toMatchObject({ type: "system", status: "error" })
    expect(refusal.type === "system" && refusal.message).toContain("status=like.open")
    await settle(peer)
    expect(peer.frames.some(isSystem("ok", "subscribed to orders"))).toBe(false)

    // Not a member: a broadcast to the channel is refused as from an outsider.
    peer.send({ type: "broadcast", channel: "orders", event: "e", payload: {} })
    await peer.next((m) => isSystem("error")(m) && peer.frames.filter(isSystem("error")).length >= 2)
  })

  it("made only of conditions it knows is accepted", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", channel: "orders-ok", table: "orders", filter: { id: "gte.1" } })
    await peer.next(isSystem("ok", "subscribed to orders-ok"))
  })
})
