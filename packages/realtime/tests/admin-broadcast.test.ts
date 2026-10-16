import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RealtimeServer } from "../src/server.js"
import { nextText } from "./fixtures/stream.js"
import {
  connect,
  freePort,
  serviceToken,
  settle,
  subscribe,
  testEnv,
  userToken,
  type Peer,
} from "./fixtures/socket.js"

/**
 * The Studio broadcast tester's endpoint: one fan-out with client broadcasts, sized, validated and
 * rate limited here so the limit holds whichever control plane, and however many replicas of it,
 * sent the request.
 */

async function post(
  adminPort: number,
  body: unknown,
  actor = "studio-user-1",
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${adminPort}/admin/v1/broadcast`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken()}`,
      "Content-Type": "application/json",
      "X-Supatype-Studio-Actor": actor,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text === "" ? null : (JSON.parse(text) as unknown) }
}

describe("POST /admin/v1/broadcast", () => {
  let server: RealtimeServer
  let port: number
  let adminPort: number
  const peers: Peer[] = []
  const open = async (sub: string, channel: string): Promise<Peer> => {
    const peer = await connect(port, userToken(sub))
    peers.push(peer)
    await subscribe(peer, channel)
    return peer
  }

  beforeAll(async () => {
    port = await freePort()
    adminPort = await freePort()
    server = new RealtimeServer(testEnv(port, { adminPort }))
    await server.start()
  })

  afterAll(async () => {
    for (const peer of peers) peer.close()
    await server.stop()
  })

  it("reaches every subscriber of the channel, and only them", async () => {
    const a = await open("a", "room:1")
    const b = await open("b", "room:1")
    const other = await open("c", "room:2")

    const res = await post(adminPort, { channel: "room:1", event: "ping", payload: { hello: "world" } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { recipients: 2 } })

    const expected = { type: "broadcast", channel: "room:1", event: "ping", payload: { hello: "world" } }
    expect(await a.next((m) => m.type === "broadcast")).toEqual(expected)
    expect(await b.next((m) => m.type === "broadcast")).toEqual(expected)
    await settle(other)
    expect(other.frames.filter((m) => m.type === "broadcast")).toEqual([])
  })

  it("shows the test broadcast on an open inspector stream as Studio's", async () => {
    await open("solo", "room:solo")
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${adminPort}/admin/v1/stream?view=redacted&kinds=broadcast`, {
      headers: { Authorization: `Bearer ${serviceToken()}`, "X-Supatype-Studio-Actor": "watcher" },
      signal: controller.signal,
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let raw = ""
    const seen = (async () => {
      while (!raw.includes("event: broadcast\n")) {
        const text = await nextText(reader, decoder)
        if (text === null) break
        raw += text
      }
    })()
    try {
      await post(adminPort, { channel: "room:solo", event: "hello", payload: { hello: "world" } }, "tester")
      await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error("no event")), 2000))])
      const event = JSON.parse(raw.split("event: broadcast\ndata: ")[1]!.split("\n")[0]!) as Record<string, unknown>
      expect(event).toMatchObject({ channel: "room:solo", event: "hello", origin: "studio", recipients: 1, payload: { hello: "world" } })
    } finally {
      controller.abort()
    }
  })

  it("refuses a payload that is not an object", async () => {
    const res = await post(adminPort, { channel: "room:1", event: "ping", payload: [1, 2] }, "validator")
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: "validation_error" })
  })

  it("refuses a missing or oversized channel or event", async () => {
    expect((await post(adminPort, { channel: "", event: "x", payload: {} }, "validator")).status).toBe(400)
    expect((await post(adminPort, { channel: "c", event: "e".repeat(256), payload: {} }, "validator")).status).toBe(400)
  })

  it("refuses a payload over 256 KB", async () => {
    const res = await post(adminPort, { channel: "room:1", event: "big", payload: { blob: "x".repeat(300 * 1024) } }, "big-sender")
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ error: "payload_too_large" })
  })

  it("allows ten a minute per actor, and says when to retry", async () => {
    const actor = "rate-limited"
    for (let i = 0; i < 10; i++) {
      expect((await post(adminPort, { channel: "room:9", event: "n", payload: { i } }, actor)).status).toBe(200)
    }
    const eleventh = await post(adminPort, { channel: "room:9", event: "n", payload: {} }, actor)
    expect(eleventh.status).toBe(429)
    expect(eleventh.body).toMatchObject({ error: "rate_limited" })
    expect(Number(eleventh.headers.get("retry-after"))).toBeGreaterThan(0)

    // Another actor is not held back by the first one's limit.
    expect((await post(adminPort, { channel: "room:9", event: "n", payload: {} }, "someone-else")).status).toBe(200)
  })
})
