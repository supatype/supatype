import { describe, expect, it } from "vitest"
import type { WebSocket } from "ws"
import { ChannelManager, parseClientParam } from "../src/channels.js"

/**
 * What the inspector lists: channels as the sum of every connection's subscriptions, and
 * connections a page at a time. Neither may carry what a connection keeps private: its token, its
 * filter values, or any claim but `sub` and `role`.
 */

const fakeSocket = {} as WebSocket

function registry(): { channels: ChannelManager; ids: string[] } {
  const channels = new ChannelManager()
  const ids = [
    channels.addClient(fakeSocket, { sub: "alice", role: "authenticated", email: "a@example.test" }, null, {
      client: parseClientParam("supatype-js/0.4.1"),
      userAgent: "vitest",
    }),
    channels.addClient(fakeSocket, { sub: "bob", role: "authenticated" }, null),
    channels.addClient(fakeSocket, null, null),
  ]
  channels.subscribe(ids[0]!, {
    channel: "room:1", schema: "public", table: "posts", event: "*", filter: { owner: "eq.secret-owner" },
  })
  channels.subscribe(ids[1]!, {
    channel: "room:1", schema: "public", table: "comments", event: "INSERT", filter: {},
  })
  channels.subscribe(ids[2]!, {
    channel: "room:2", schema: "public", table: "posts", event: "*", filter: {},
  })
  channels.trackPresence(ids[1]!, "room:1", { user_id: "bob" })
  return { channels, ids }
}

describe("ChannelManager.listChannels", () => {
  it("aggregates every connection's subscriptions by channel name", () => {
    const { channels } = registry()
    const { channels: list, truncated } = channels.listChannels(null)

    expect(truncated).toBe(false)
    expect(list.map((c) => c.name)).toEqual(["room:1", "room:2"])
    const room1 = list[0]!
    expect(room1.subscribers).toBe(2)
    expect(room1.presence).toBe(1)
    expect(room1.targets).toEqual([
      { schema: "public", table: "comments", event: "INSERT", filtered: false, subscribers: 1 },
      { schema: "public", table: "posts", event: "*", filtered: true, subscribers: 1 },
    ])
    expect(Number.isNaN(Date.parse(room1.createdAt))).toBe(false)
    expect(room1.lastEventAt).toBeNull()
    expect(list[1]!.subscribers).toBe(1)
  })

  it("never returns a filter value", () => {
    const { channels } = registry()
    expect(JSON.stringify(channels.listChannels(null))).not.toContain("secret-owner")
  })

  it("records the last event on a channel", () => {
    const { channels } = registry()
    channels.touchChannel("room:2", null)
    const room2 = channels.listChannels(null).channels.find((c) => c.name === "room:2")
    expect(room2?.lastEventAt).not.toBeNull()
  })
})

describe("ChannelManager.listConnections", () => {
  it("pages with a cursor", () => {
    const { channels, ids } = registry()
    const first = channels.listConnections({ limit: 1, after: null, projectRef: null })
    expect(first.total).toBe(3)
    expect(first.connections).toHaveLength(1)
    expect(first.connections[0]!.id).toBe(ids[0])
    expect(first.next).toBe(ids[0])

    const rest = channels.listConnections({ limit: 5, after: first.next, projectRef: null })
    expect(rest.connections.map((c) => c.id)).toEqual([ids[1], ids[2]])
    expect(rest.next).toBeNull()
  })

  it("reports who each connection is, and nothing else they carry", () => {
    const { channels } = registry()
    const [alice, , stranger] = channels.listConnections({ limit: 10, after: null, projectRef: null }).connections
    expect(alice).toMatchObject({
      userId: "alice",
      role: "authenticated",
      channels: ["room:1"],
      client: { name: "supatype-js", version: "0.4.1" },
      userAgent: "vitest",
      lastMessageAt: null,
    })
    expect(stranger).toMatchObject({ userId: null, role: null, client: null, userAgent: null })
    const serialised = JSON.stringify(channels.listConnections({ limit: 10, after: null, projectRef: null }))
    expect(serialised).not.toContain("a@example.test")
    expect(serialised).not.toContain("secret-owner")
  })

  it("stamps the last frame a connection sent", () => {
    const { channels, ids } = registry()
    channels.noteMessage(ids[1]!)
    const bob = channels.listConnections({ limit: 10, after: null, projectRef: null }).connections[1]
    expect(bob?.lastMessageAt).not.toBeNull()
  })
})

describe("parseClientParam", () => {
  it("reads name/version, a bare name, and nothing", () => {
    expect(parseClientParam("supatype-js/1.2.3")).toEqual({ name: "supatype-js", version: "1.2.3" })
    expect(parseClientParam("my-app")).toEqual({ name: "my-app", version: null })
    expect(parseClientParam(null)).toBeNull()
    expect(parseClientParam("")).toBeNull()
  })

  it("bounds what a client may put in it", () => {
    expect(parseClientParam("x".repeat(500))?.name.length).toBeLessThanOrEqual(64)
  })
})
