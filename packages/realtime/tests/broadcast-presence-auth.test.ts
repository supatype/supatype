import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RealtimeServer } from "../src/server.js"
import { ChannelManager, type ClientSocket } from "../src/channels.js"
import type { ServerMessage } from "../src/types.js"
import {
  anonKey,
  connect,
  freePort,
  isSystem,
  settle,
  subscribe as subscribeTo,
  testEnv,
  userToken,
  type Peer,
} from "./fixtures/socket.js"

/**
 * Broadcast and presence are only for a client that proved who it is and joined the channel.
 *
 * Both used to be dispatched for any socket at all: a client with no token could broadcast to,
 * and announce presence on, any channel name, without subscribing to it, and a presence payload
 * carrying `user_id` replaced the identity the server had verified. These run the real server
 * over a real socket, because the refusal is a property of the message dispatch, not of any one
 * helper.
 */

const CHANNEL = "room-1"

const subscribe = (peer: Peer, channel = CHANNEL): Promise<void> => subscribeTo(peer, channel)

function relayed(peer: Peer): ServerMessage[] {
  return peer.frames.filter((m) => m.type === "broadcast" || m.type === "presence")
}

describe.each([true, false])("broadcast and presence (secureChannels %s)", (secureChannels) => {
  let server: RealtimeServer
  let port: number
  const peers: Peer[] = []
  const open = async (token?: string): Promise<Peer> => {
    const peer = await connect(port, token)
    peers.push(peer)
    return peer
  }

  beforeAll(async () => {
    port = await freePort()
    server = new RealtimeServer(testEnv(port, { secureChannels }))
    await server.start()
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server.stop()
  })

  it("refuses a broadcast from a client with no token, and relays nothing", async () => {
    const listener = await open(userToken("listener-a"))
    await subscribe(listener)
    const stranger = await open()

    stranger.send({ type: "broadcast", channel: CHANNEL, event: "msg", payload: { text: "spoofed" } })
    const refusal = await stranger.next(isSystem("error"))

    // Naming the channel, so the client fails that channel and not every other one on the socket.
    expect(refusal).toMatchObject({ type: "system", status: "error", channel: CHANNEL })
    await settle(listener)
    expect(relayed(listener)).toEqual([])
  })

  it("refuses presence_track and presence_untrack from a client with no token", async () => {
    const listener = await open(userToken("listener-b"))
    await subscribe(listener)
    const stranger = await open()

    stranger.send({ type: "presence_track", channel: CHANNEL, payload: { user_id: "listener-b" } })
    await stranger.next(isSystem("error"))
    stranger.send({ type: "presence_untrack", channel: CHANNEL })
    await stranger.next((m) => isSystem("error")(m) && stranger.frames.filter(isSystem("error")).length >= 2)

    await settle(listener)
    expect(relayed(listener)).toEqual([])
  })

  it.runIf(secureChannels)("refuses a subscribe before authenticating, naming the channel", async () => {
    const stranger = await open()
    stranger.send({ type: "subscribe", channel: CHANNEL })
    expect(await stranger.next(isSystem("error", "authenticate before subscribing"))).toMatchObject({ channel: CHANNEL })
  })

  it("refuses a broadcast to a channel the sender has not joined", async () => {
    const listener = await open(userToken("listener-c"))
    await subscribe(listener)
    const outsider = await open(userToken("outsider"))

    outsider.send({ type: "broadcast", channel: CHANNEL, event: "msg", payload: { text: "hi" } })
    expect(await outsider.next(isSystem("error"))).toMatchObject({ channel: CHANNEL })
    outsider.send({ type: "presence_track", channel: CHANNEL, payload: {} })
    await outsider.next((m) => isSystem("error")(m) && outsider.frames.filter(isSystem("error")).length >= 2)

    await settle(listener)
    expect(relayed(listener)).toEqual([])
  })

  it("relays a subscribed, signed-in client's broadcast to the channel's other members", async () => {
    const channel = "room-relay"
    const listener = await open(userToken("listener-d"))
    await subscribe(listener, channel)
    const sender = await open(userToken("sender-d"))
    await subscribe(sender, channel)

    sender.send({ type: "broadcast", channel, event: "msg", payload: { text: "hello" } })
    const got = await listener.next((m) => m.type === "broadcast")

    expect(got).toEqual({ type: "broadcast", channel, event: "msg", payload: { text: "hello" } })
  })

  it("tracks presence under the verified subject, whatever the payload claims", async () => {
    const channel = "room-presence"
    const listener = await open(userToken("listener-e"))
    await subscribe(listener, channel)
    const member = await open(userToken("member-e"))
    await subscribe(member, channel)

    member.send({ type: "presence_track", channel, payload: { user_id: "listener-e", status: "online" } })
    const join = await listener.next((m) => m.type === "presence")

    expect(join).toMatchObject({ type: "presence", channel, leaves: [] })
    expect(join.type === "presence" && join.joins).toEqual([{ user_id: "member-e", status: "online" }])
  })

  it("lets an anon-key client that joined broadcast, and never as a user", async () => {
    const channel = "room-anon"
    const listener = await open(userToken("listener-f"))
    await subscribe(listener, channel)
    const visitor = await open(anonKey())
    await subscribe(visitor, channel)

    visitor.send({ type: "broadcast", channel, event: "wave", payload: { from: "visitor" } })
    await listener.next((m) => m.type === "broadcast")
    visitor.send({ type: "presence_track", channel, payload: { user_id: "listener-f" } })
    const join = await listener.next((m) => m.type === "presence")

    expect(join.type === "presence" && join.joins[0]?.user_id).toBe("anonymous")
  })

  it("tells the channel a member left when it unsubscribes while tracked", async () => {
    const channel = "room-leave"
    const listener = await open(userToken("listener-g"))
    await subscribe(listener, channel)
    const member = await open(userToken("member-g"))
    await subscribe(member, channel)
    member.send({ type: "presence_track", channel, payload: {} })
    await listener.next((m) => m.type === "presence" && m.joins.length === 1)

    member.send({ type: "unsubscribe", channel })
    const leave = await listener.next((m) => m.type === "presence" && m.leaves.length === 1)

    expect(leave.type === "presence" && leave.leaves).toEqual([{ user_id: "member-g" }])
  })

  it("sends a newcomer the members already here, right after its join is accepted", async () => {
    const channel = "room-state"
    const first = await open(userToken("first-h"))
    await subscribe(first, channel)
    first.send({ type: "presence_track", channel, payload: { status: "here" } })
    await first.next((m) => m.type === "presence")

    const newcomer = await open(userToken("newcomer-h"))
    await subscribe(newcomer, channel)
    const state = await newcomer.next((m) => m.type === "presence")

    expect(state).toEqual({ type: "presence", channel, joins: [{ user_id: "first-h", status: "here" }], leaves: [] })
    const accepted = newcomer.frames.findIndex(isSystem("ok", `subscribed to ${channel}`))
    expect(newcomer.frames.indexOf(state)).toBeGreaterThan(accepted)
  })

  it("sends no presence to a newcomer when nobody is tracked on the channel", async () => {
    const channel = "room-empty"
    const newcomer = await open(userToken("newcomer-i"))
    await subscribe(newcomer, channel)

    await settle(newcomer)
    expect(relayed(newcomer)).toEqual([])
  })
})

describe("channel members on a shared instance", () => {
  it("are counted within the sender's project only", () => {
    const channels = new ChannelManager()
    const ws: ClientSocket = { readyState: 1, send: () => {} }
    const claims = { sub: "u", role: "authenticated" }
    const a = channels.addClient(ws, claims, "project-a")
    const b = channels.addClient(ws, claims, "project-b")
    for (const id of [a, b]) {
      channels.subscribe(id, { channel: "lobby", schema: "public", table: "lobby", event: "*", filter: {} })
    }

    expect(channels.getChannelClients("lobby", "project-a").map((c) => c.clientId)).toEqual([a])
    expect(channels.getChannelClients("lobby", "project-b").map((c) => c.clientId)).toEqual([b])
  })

  it("report presence within the asking project only", () => {
    const channels = new ChannelManager()
    const ws: ClientSocket = { readyState: 1, send: () => {} }
    const claims = { sub: "u", role: "authenticated" }
    const a = channels.addClient(ws, claims, "project-a")
    const b = channels.addClient(ws, claims, "project-b")
    channels.trackPresence(a, "lobby", { user_id: "in-a" })
    channels.trackPresence(b, "lobby", { user_id: "in-b" })

    expect(channels.getPresence("lobby", "project-a")).toEqual([{ user_id: "in-a" }])
    expect(channels.getPresence("lobby", "project-b")).toEqual([{ user_id: "in-b" }])
  })
})
