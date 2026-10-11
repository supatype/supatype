import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "node:net"
import jwt from "jsonwebtoken"
import { WebSocket } from "ws"
import { RealtimeServer } from "../src/server.js"
import type { RealtimeEnv } from "../src/env.js"
import type { ServerMessage } from "../src/types.js"

/**
 * Broadcast and presence are only for a client that proved who it is and joined the channel.
 *
 * Both used to be dispatched for any socket at all: a client with no token could broadcast to,
 * and announce presence on, any channel name, without subscribing to it, and a presence payload
 * carrying `user_id` replaced the identity the server had verified. These run the real server
 * over a real socket, because the refusal is a property of the message dispatch, not of any one
 * helper.
 */

const SECRET = "realtime-broadcast-presence-test-secret-0123456789"
const CHANNEL = "room-1"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function testEnv(port: number, secureChannels: boolean): RealtimeEnv {
  return {
    port,
    // Nothing listens here. Replication retries in the background, which is all these need:
    // broadcast and presence never touch the database.
    databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/none",
    jwtSecret: SECRET,
    slotName: "unused",
    publicationName: "unused",
    replicationPollInterval: 1000,
    secureChannels,
    multiTenant: false,
    routingTableRefreshMs: 60_000,
    schemaFilterMode: "developer_only",
    connectionLimits: {},
  }
}

function userToken(sub: string): string {
  return jwt.sign({ sub, role: "authenticated", aud: "authenticated" }, SECRET, { expiresIn: 600 })
}

/** The anon key a signed-out SDK client connects with: verified, but naming no user. */
function anonKey(): string {
  return jwt.sign({ role: "anon", iss: "supatype" }, SECRET, { expiresIn: 600 })
}

/** A socket and every frame it has received, so a test can wait for one or prove there was none. */
interface Peer {
  ws: WebSocket
  frames: ServerMessage[]
  send(msg: Record<string, unknown>): void
  next(match: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>
  close(): void
}

async function connect(port: number, token?: string): Promise<Peer> {
  const url = token === undefined
    ? `ws://127.0.0.1:${port}`
    : `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(url)
  const frames: ServerMessage[] = []
  const waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = []
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage
    frames.push(msg)
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(msg)
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })
  return {
    ws,
    frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (match, timeoutMs = 2000) => {
      const seen = frames.find(match)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs)
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m) } })
      })
    },
    close: () => ws.close(),
  }
}

const isSystem = (status: "ok" | "error", text?: string) => (m: ServerMessage): boolean =>
  m.type === "system" && m.status === status && (text === undefined || m.message.includes(text))

async function subscribe(peer: Peer, channel = CHANNEL): Promise<void> {
  peer.send({ type: "subscribe", channel })
  await peer.next(isSystem("ok", `subscribed to ${channel}`))
}

/** Round-trips a frame, so anything the server was going to send before it has arrived. */
async function settle(peer: Peer): Promise<void> {
  const marker = `settle-${Math.random().toString(36).slice(2)}`
  peer.send({ type: "unsubscribe", channel: marker })
  await peer.next(isSystem("ok", `unsubscribed from ${marker}`))
}

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
    server = new RealtimeServer(testEnv(port, secureChannels))
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

    expect(refusal).toMatchObject({ type: "system", status: "error" })
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

  it("refuses a broadcast to a channel the sender has not joined", async () => {
    const listener = await open(userToken("listener-c"))
    await subscribe(listener)
    const outsider = await open(userToken("outsider"))

    outsider.send({ type: "broadcast", channel: CHANNEL, event: "msg", payload: { text: "hi" } })
    await outsider.next(isSystem("error"))
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
})

describe("channel members on a shared instance", () => {
  it("are counted within the sender's project only", async () => {
    const { ChannelManager } = await import("../src/channels.js")
    const channels = new ChannelManager()
    const ws = { readyState: 1, send: () => {} } as unknown as Parameters<ChannelManager["addClient"]>[0]
    const claims = { sub: "u", role: "authenticated" }
    const a = channels.addClient(ws, claims, "project-a")
    const b = channels.addClient(ws, claims, "project-b")
    for (const id of [a, b]) {
      channels.subscribe(id, { channel: "lobby", schema: "public", table: "lobby", event: "*", filter: {} })
    }

    expect(channels.getChannelClients("lobby", "project-a").map((c) => c.clientId)).toEqual([a])
    expect(channels.getChannelClients("lobby", "project-b").map((c) => c.clientId)).toEqual([b])
  })
})
