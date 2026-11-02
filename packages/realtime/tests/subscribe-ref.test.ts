import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RealtimeServer } from "../src/server.js"
import { connect, freePort, isSystem, settle, testEnv, userToken, type Peer } from "./fixtures/socket.js"
import type { ServerMessage, SystemMessage } from "../src/types.js"

/**
 * A reply to a join carries the `ref` the join carried, so a client can tell which of two joins on
 * one channel name it answers.
 *
 * Replies named only the channel. A client that joined, left and joined again on one name before
 * the first reply arrived read the first join's acknowledgement as the second's, and reported
 * SUBSCRIBED for a join this server went on to refuse.
 */

const isSystemFrame = (m: ServerMessage): m is SystemMessage => m.type === "system"

describe("a reply to a join with a ref", () => {
  let server: RealtimeServer
  let port: number
  const peers: Peer[] = []
  const open = async (): Promise<Peer> => {
    const peer = await connect(port, userToken("ref-user"))
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

  it("echoes each join's ref, in order, on acknowledgements and refusals alike", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", channel: "orders", table: "orders", ref: "1" })
    peer.send({ type: "unsubscribe", channel: "orders" })
    peer.send({ type: "subscribe", channel: "orders", table: "orders", filter: { status: "like.open" }, ref: "2" })
    await settle(peer)

    const replies = peer.frames.filter(isSystemFrame).filter((m) => m.ref !== undefined)
    expect(replies).toMatchObject([
      { status: "ok", message: "subscribed to orders", ref: "1" },
      { status: "error", channel: "orders", ref: "2" },
    ])
  })

  it("carries no ref when the join carried none, as before refs existed", async () => {
    const peer = await open()
    peer.send({ type: "subscribe", channel: "plain", table: "orders" })
    await settle(peer)

    const ack = peer.frames.find(isSystem("ok", "subscribed to plain"))
    expect(ack).toBeDefined()
    expect(ack !== undefined && "ref" in ack).toBe(false)
  })
})
