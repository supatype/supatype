import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { ChannelManager } from "../channels.js"
import { AdminError, sendData, sendError } from "./http.js"
import { requireServiceRole } from "./auth.js"
import { BroadcastLimiter, handleBroadcast, type BroadcastInput } from "./broadcast.js"
import { openStream } from "./stream.js"
import type { Tap } from "./tap.js"
import type { ViewRules } from "./views.js"

/**
 * The realtime admin API, on a listener of its own (`ADMIN_PORT`).
 *
 *   GET  /admin/v1/channels      every channel, its subscribers, targets and last event
 *   GET  /admin/v1/connections   connections a page at a time, with the instance's limit
 *   GET  /admin/v1/stream        the live stream (SSE), per payload view
 *   POST /admin/v1/broadcast     a test broadcast from Studio
 *
 * Never a path on the public port: the gateway proxies every path under `/realtime/v1` there.
 * Every route requires the service role (see `auth.ts`).
 */

const CONNECTIONS_DEFAULT = 100
const CONNECTIONS_MAX = 500

/** What the admin API reads from, and sends through, the realtime server. */
export interface AdminDeps {
  channels: ChannelManager
  tap: Tap
  rules: ViewRules
  /** Whether replication is up, and why not when it never will be. */
  service(): { ready: boolean; reason: string | null }
  /** The single-tenant connection limit, or null. */
  connectionLimit(projectRef: string | null): number | null
  /** The secret tokens for `projectRef` are signed with, or null for an unknown project. */
  secretFor(projectRef: string | null): string | null
  multiTenant: boolean
  /** Fan a test broadcast out to the channel, returning how many sockets it reached. */
  broadcast(input: BroadcastInput, projectRef: string | null): number
}

interface Routed {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  projectRef: string | null
  secret: string
}

export class AdminServer {
  private server: Server | null = null
  private readonly limiter = new BroadcastLimiter()

  constructor(private readonly deps: AdminDeps) {}

  async start(port: number, host?: string): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, host, () => {
        console.log(`[realtime] admin API listening on port ${port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.deps.tap.closeAll()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://admin.local")
      const { projectRef, secret } = this.resolveProject(url)
      requireServiceRole(req, secret)
      await this.route({ req, res, url, projectRef, secret })
    } catch (err) {
      if (res.headersSent) return
      if (err instanceof AdminError) {
        sendError(res, err.status, err.code, err.message, err.headers)
        return
      }
      console.error("[realtime] admin API error:", err)
      sendError(res, 500, "internal_error", "The realtime admin API failed")
    }
  }

  /** Multi-tenant: `?project=` names the project, and its secret verifies the caller. */
  private resolveProject(url: URL): { projectRef: string | null; secret: string } {
    const projectRef = this.deps.multiTenant ? url.searchParams.get("project") : null
    if (this.deps.multiTenant && !projectRef) {
      throw new AdminError(400, "validation_error", "project is required on a multi-tenant instance")
    }
    const secret = this.deps.secretFor(projectRef)
    if (secret === null) throw new AdminError(404, "not_found", "Unknown project")
    return { projectRef, secret }
  }

  private async route(r: Routed): Promise<void> {
    const method = r.req.method ?? "GET"
    switch (`${method} ${r.url.pathname}`) {
      case "GET /admin/v1/channels":
        sendData(r.res, { service: this.deps.service(), ...this.deps.channels.listChannels(r.projectRef) })
        return
      case "GET /admin/v1/connections":
        sendData(r.res, this.connections(r))
        return
      case "GET /admin/v1/stream":
        openStream(r.req, r.res, r.url, { tap: this.deps.tap, rules: this.deps.rules, secret: r.secret })
        return
      case "POST /admin/v1/broadcast":
        await handleBroadcast(r.req, r.res, this.limiter, (input) => this.deps.broadcast(input, r.projectRef))
        return
      default:
        throw new AdminError(404, "not_found", "No such admin route")
    }
  }

  private connections(r: Routed): Record<string, unknown> {
    const raw = r.url.searchParams.get("limit")
    const limit = raw === null || raw === "" ? CONNECTIONS_DEFAULT : Number(raw)
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AdminError(400, "validation_error", "limit must be a positive whole number")
    }
    const after = r.url.searchParams.get("after")
    const page = this.deps.channels.listConnections({
      limit: Math.min(limit, CONNECTIONS_MAX),
      after: after === "" ? null : after,
      projectRef: r.projectRef,
    })
    return { ...page, limit: this.deps.connectionLimit(r.projectRef) }
  }
}
