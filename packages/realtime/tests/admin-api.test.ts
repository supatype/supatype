import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createConnection } from "node:net"
import { RealtimeServer } from "../src/server.js"
import {
  connect,
  freePort,
  serviceToken,
  subscribe,
  testEnv,
  userToken,
  type Peer,
} from "./fixtures/socket.js"

/**
 * The realtime admin API: a listener of its own, answering only the service role.
 *
 * Its own port because the gateway proxies every path under `/realtime/v1` to the public one, so an
 * admin route there would be on the internet. The service-role check is the real boundary in both
 * deployment modes: neither the compose network nor a Cloud namespace isolates the port.
 */

async function get(port: number, path: string, token?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...(token !== undefined && { headers: { Authorization: `Bearer ${token}` } }),
  })
  const text = await res.text()
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

describe("the admin listener", () => {
  let server: RealtimeServer
  let port: number
  let adminPort: number
  const peers: Peer[] = []

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

  it("refuses a request with no token", async () => {
    expect((await get(adminPort, "/admin/v1/channels")).status).toBe(401)
  })

  it("refuses a token that does not verify", async () => {
    expect((await get(adminPort, "/admin/v1/channels", "not-a-jwt")).status).toBe(401)
  })

  it("refuses a signed-in user who is not the service role", async () => {
    const res = await get(adminPort, "/admin/v1/channels", userToken("alice"))
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: "forbidden" })
  })

  it("answers the service role with the channels shape", async () => {
    const peer = await connect(port, userToken("alice"))
    peers.push(peer)
    await subscribe(peer, "room:1", { table: "posts" })

    const res = await get(adminPort, "/admin/v1/channels", serviceToken())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      data: {
        service: { ready: false },
        channels: [{ name: "room:1", subscribers: 1, presence: 0 }],
      },
    })
  })

  it("lists connections without the token any of them connected with", async () => {
    const token = userToken("token-holder")
    const peer = await connect(port, token, "client=supatype-js/9.9.9")
    peers.push(peer)

    const res = await get(adminPort, "/admin/v1/connections?limit=500", serviceToken())
    expect(res.status).toBe(200)
    const text = JSON.stringify(res.body)
    expect(text).toContain("token-holder")
    expect(text).toContain("supatype-js")
    expect(text).not.toContain(token)
    expect(res.body).toMatchObject({ data: { limit: null } })
  })

  it("is not on the public port", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/v1/channels`, {
      headers: { Authorization: `Bearer ${serviceToken()}` },
    })
    expect(res.status).toBe(404)
  })

  it("answers an unknown admin path with 404", async () => {
    expect((await get(adminPort, "/admin/v1/nothing", serviceToken())).status).toBe(404)
  })

  it("allows two streams per actor and five in all", async () => {
    const controllers: AbortController[] = []
    const opened = async (actor: string): Promise<number> => {
      const controller = new AbortController()
      controllers.push(controller)
      const res = await fetch(`http://127.0.0.1:${adminPort}/admin/v1/stream?view=none`, {
        headers: { Authorization: `Bearer ${serviceToken()}`, "X-Supatype-Studio-Actor": actor },
        signal: controller.signal,
      })
      if (res.status !== 200) await res.text()
      return res.status
    }
    try {
      expect(await opened("a")).toBe(200)
      expect(await opened("a")).toBe(200)
      expect(await opened("a")).toBe(429)
      expect(await opened("b")).toBe(200)
      expect(await opened("b")).toBe(200)
      expect(await opened("c")).toBe(200)
      expect(await opened("d")).toBe(429)
    } finally {
      for (const c of controllers) c.abort()
    }
  })
})

describe("without ADMIN_PORT", () => {
  it("opens no admin listener at all", async () => {
    const port = await freePort()
    const unused = await freePort()
    const server = new RealtimeServer(testEnv(port))
    await server.start()
    try {
      expect(await listening(unused)).toBe(false)
      expect(await listening(port)).toBe(true)
    } finally {
      await server.stop()
    }
  })
})
