import { strict as assert } from "node:assert"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { test, describe, before, after, beforeEach } from "node:test"
import { CONTROL_PLANE_SECRET_HEADER } from "../src/auth.js"
import { setAuditWriter, type AuditEntry } from "../src/audit.js"
import { startServer, TEST_SECRET, request, type ControlPlaneServer } from "./helpers.js"

/**
 * The Realtime Inspector's self-host routes: the control plane authenticates the Studio user (the
 * gateway names them in headers only it can set), decides which payloads they may see, and relays
 * to realtime's admin API with the service-role key.
 */

const PROJECT = "test-project"
const SERVICE_KEY = "service-role-key-for-tests"

interface Seen {
  method: string
  path: string
  headers: IncomingMessage["headers"]
  body: string
}

/** A fake realtime admin API that records what reached it. */
function fakeRealtime(): Promise<{ server: Server; url: string; seen: Seen[]; streamClosed: () => Promise<void> }> {
  const seen: Seen[] = []
  let closed: () => void = () => {}
  const closedPromise = new Promise<void>((resolve) => {
    closed = resolve
  })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake")
      seen.push({ method: req.method ?? "", path: `${url.pathname}${url.search}`, headers: req.headers, body: Buffer.concat(chunks).toString() })
      if (url.pathname === "/admin/v1/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`event: ready\ndata: ${JSON.stringify({ view: url.searchParams.get("view") })}\n\n`)
        req.on("close", () => closed())
        res.on("close", () => closed())
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      if (url.pathname === "/admin/v1/channels") res.end(JSON.stringify({ data: { service: { ready: true, reason: null }, channels: [] } }))
      else if (url.pathname === "/admin/v1/connections") res.end(JSON.stringify({ data: { total: 0, limit: null, connections: [], next: null } }))
      else if (url.pathname === "/admin/v1/broadcast") res.end(JSON.stringify({ data: { recipients: 2 } }))
      else res.end("{}")
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}`, seen, streamClosed: () => closedPromise })
    })
  })
}

/** Headers the gateway sets for a Studio user it admitted. */
function studio(role: string, elevated: boolean): Record<string, string> {
  return {
    [CONTROL_PLANE_SECRET_HEADER]: TEST_SECRET,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "X-Supatype-Studio-Actor": "11111111-2222-3333-4444-555555555555",
    "X-Supatype-Studio-Role": role,
    "X-Supatype-Studio-Elevated": String(elevated),
    ...(elevated ? {} : { "X-Supatype-Viewer-Authorization": "Bearer developer-own-token" }),
  }
}

describe("realtime inspector routes", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let realtime: Awaited<ReturnType<typeof fakeRealtime>>
  const audits: AuditEntry[] = []

  before(async () => {
    realtime = await fakeRealtime()
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["REALTIME_ADMIN_URL"] = realtime.url
    process.env["SUPATYPE_SERVICE_ROLE_KEY"] = SERVICE_KEY
    setAuditWriter({ record: async (entry) => { audits.push(entry) } })
    ;({ server, baseUrl } = await startServer())
  })

  beforeEach(() => {
    realtime.seen.length = 0
    audits.length = 0
  })

  after(() => {
    server.close()
    realtime.server.close()
    delete process.env["REALTIME_ADMIN_URL"]
    delete process.env["SUPATYPE_SERVICE_ROLE_KEY"]
  })

  async function get(path: string, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, { headers })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  test("GET /project names the project this control plane serves", async () => {
    const res = await request(baseUrl, "GET", "/project")
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { data: { ref: PROJECT } })
  })

  test("channels pass through, as the service role and for the actor", async () => {
    const res = await get(`/projects/${PROJECT}/realtime/channels`, studio("developer", false))
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { data: { service: { ready: true, reason: null }, channels: [] } })
    assert.equal(realtime.seen[0]?.headers["authorization"], `Bearer ${SERVICE_KEY}`)
    assert.equal(realtime.seen[0]?.headers["x-supatype-studio-actor"], "11111111-2222-3333-4444-555555555555")
    assert.equal(realtime.seen[0]?.headers["x-supatype-viewer-authorization"], undefined)
  })

  test("connections say there is no tier on self-host", async () => {
    const res = await get(`/projects/${PROJECT}/realtime/connections?limit=50&after=3`, studio("developer", false))
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { data: { total: 0, limit: null, connections: [], next: null, tier: null } })
    assert.equal(realtime.seen[0]?.path, "/admin/v1/connections?limit=50&after=3")
  })

  test("a developer's stream is judged as them, even when they ask for more", async () => {
    for (const asked of ["", "&view=delivered"]) {
      realtime.seen.length = 0
      const controller = new AbortController()
      const res = await fetch(`${baseUrl}/projects/${PROJECT}/realtime/stream?table=posts${asked}`, {
        headers: studio("developer", false),
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get("content-type"), "text/event-stream")
      controller.abort()
      const upstream = new URL(realtime.seen[0]!.path, "http://x")
      assert.equal(upstream.searchParams.get("view"), "viewer")
      assert.equal(upstream.searchParams.get("table"), "posts")
      assert.equal(realtime.seen[0]?.headers["x-supatype-viewer-authorization"], "Bearer developer-own-token")
    }
    assert.equal(audits.length, 0)
  })

  test("an admin's stream shows deliveries as received, and is audited", async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/projects/${PROJECT}/realtime/stream?channel=room`, {
      headers: studio("admin", true),
      signal: controller.signal,
    })
    assert.equal(res.status, 200)
    controller.abort()
    const upstream = new URL(realtime.seen[0]!.path, "http://x")
    assert.equal(upstream.searchParams.get("view"), "delivered")
    assert.equal(realtime.seen[0]?.headers["x-supatype-viewer-authorization"], undefined)
    assert.equal(audits.length, 1)
    assert.equal(audits[0]?.action, "realtime_inspect")
    assert.deepEqual(audits[0]?.detail, { view: "delivered", filters: { channel: "room" } })
  })

  test("closing the browser's stream closes realtime's within a second", async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/projects/${PROJECT}/realtime/stream`, {
      headers: studio("developer", false),
      signal: controller.signal,
    })
    assert.equal(res.status, 200)
    const closed = realtime.streamClosed()
    controller.abort()
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream still open after 1 s")), 1000)),
    ])
  })

  test("a broadcast is audited with its size, never its payload", async () => {
    const res = await fetch(`${baseUrl}/projects/${PROJECT}/realtime/broadcast`, {
      method: "POST",
      headers: { ...studio("developer", false), "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "room:1", event: "ping", payload: { secret: "do-not-log-me" } }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { data: { recipients: 2 } })
    assert.equal(JSON.parse(realtime.seen[0]!.body).payload.secret, "do-not-log-me")
    assert.equal(audits.length, 1)
    assert.equal(audits[0]?.action, "realtime_broadcast")
    assert.equal(audits[0]?.actorId, "11111111-2222-3333-4444-555555555555")
    assert.deepEqual(audits[0]?.detail, { channel: "room:1", event: "ping", payloadBytes: 26, recipients: 2 })
    assert.ok(!JSON.stringify(audits).includes("do-not-log-me"))
  })

  test("another project's ref is unknown, status included", async () => {
    assert.equal((await request(baseUrl, "GET", "/projects/other/realtime/channels")).status, 404)
    assert.equal((await request(baseUrl, "GET", "/projects/other/status")).status, 404)
  })
})

describe("realtime turned off", () => {
  let baseUrl: string
  let server: ControlPlaneServer

  before(async () => {
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    delete process.env["REALTIME_ADMIN_URL"]
    ;({ server, baseUrl } = await startServer())
  })

  after(() => server.close())

  test("answers 501 realtime_disabled", async () => {
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/realtime/channels`)
    assert.equal(res.status, 501)
    assert.equal(res.json["error"], "realtime_disabled")
  })
})

describe("realtime unreachable", () => {
  let baseUrl: string
  let server: ControlPlaneServer

  before(async () => {
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["REALTIME_ADMIN_URL"] = "http://127.0.0.1:9"
    process.env["SUPATYPE_SERVICE_ROLE_KEY"] = SERVICE_KEY
    ;({ server, baseUrl } = await startServer())
  })

  after(() => {
    server.close()
    delete process.env["REALTIME_ADMIN_URL"]
  })

  test("answers 503 realtime_unavailable", async () => {
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/realtime/channels`)
    assert.equal(res.status, 503)
    assert.equal(res.json["error"], "realtime_unavailable")
  })
})
