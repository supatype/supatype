import { createServer } from "node:net"
import jwt from "jsonwebtoken"
import { WebSocket } from "ws"
import type { RealtimeEnv } from "../../src/env.js"
import type { ServerMessage } from "../../src/types.js"

/**
 * What the suites that run the real server over real sockets share: a free port, an environment, a
 * token, and a socket that remembers every frame it was sent.
 */

export const SECRET = "realtime-broadcast-presence-test-secret-0123456789"

export function freePort(): Promise<number> {
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

/**
 * An environment for a server whose database is nowhere, unless `databaseUrl` names one.
 *
 * Replication retries in the background against the missing database, which is all a suite that
 * never touches table changes needs.
 */
export function testEnv(port: number, over: Partial<RealtimeEnv> = {}): RealtimeEnv {
  return {
    port,
    databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/none",
    jwtSecret: SECRET,
    slotName: "unused",
    publicationName: "unused",
    replicationPollInterval: 1000,
    secureChannels: true,
    logLevel: "info",
    multiTenant: false,
    routingTableRefreshMs: 60_000,
    schemaFilterMode: "developer_only",
    connectionLimits: {},
    ...over,
  }
}

export function userToken(sub: string, secret = SECRET): string {
  return jwt.sign({ sub, role: "authenticated", aud: "authenticated" }, secret, { expiresIn: 600 })
}

export function serviceToken(secret = SECRET): string {
  return jwt.sign({ role: "service_role", iss: "supatype" }, secret, { expiresIn: 600 })
}

/** The anon key a signed-out SDK client connects with: verified, but naming no user. */
export function anonKey(secret = SECRET): string {
  return jwt.sign({ role: "anon", iss: "supatype" }, secret, { expiresIn: 600 })
}

/** A socket and every frame it has received, so a test can wait for one or prove there was none. */
export interface Peer {
  ws: WebSocket
  frames: ServerMessage[]
  send(msg: Record<string, unknown>): void
  next(match: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>
  close(): void
}

/** Open a socket to `port`, with `token` and any further query string in `query`. */
export async function connect(port: number, token?: string, query = ""): Promise<Peer> {
  const params = new URLSearchParams(query)
  if (token !== undefined) params.set("token", token)
  const search = params.toString()
  const ws = new WebSocket(`ws://127.0.0.1:${port}${search === "" ? "" : `?${search}`}`)
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

export const isSystem = (status: "ok" | "error", text?: string) => (m: ServerMessage): boolean =>
  m.type === "system" && m.status === status && (text === undefined || m.message.includes(text))

/** Subscribe `peer` to `channel`, optionally to a table, and wait for the server to accept it. */
export async function subscribe(
  peer: Peer,
  channel: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  peer.send({ type: "subscribe", channel, ...extra })
  await peer.next(isSystem("ok", `subscribed to ${channel}`))
}

/** Round-trips a frame, so anything the server was going to send before it has arrived. */
export async function settle(peer: Peer): Promise<void> {
  const marker = `settle-${Math.random().toString(36).slice(2)}`
  peer.send({ type: "unsubscribe", channel: marker })
  await peer.next(isSystem("ok", `unsubscribed from ${marker}`))
}
