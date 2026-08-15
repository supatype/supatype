import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import { createServer } from "node:http"
import type { RealtimeEnv } from "./env.js"
import { verifyToken, type JwtClaims } from "./auth.js"
import { ChannelManager, type ConnectedClient } from "./channels.js"
import { ReplicationListener } from "./replication.js"
import { RealtimeUnsupportedError } from "./capability.js"
import { RlsFilter } from "./rls.js"
import { filterIsMaskSafe } from "./field-mask.js"
import type {
  ClientMessage,
  ServerMessage,
  Subscription,
  WalChange,
  ChangeEvent,
  PresenceEntry,
} from "./types.js"

/** Cached routing table entry for multi-tenant mode. */
interface ProjectRoute {
  ref: string
  jwtSecret: string
  tier: string
  status: string
}

export class RealtimeServer {
  private env: RealtimeEnv
  private wss: WebSocketServer | null = null
  private channels: ChannelManager
  private replication: ReplicationListener
  private rlsFilter: RlsFilter
  private httpServer: ReturnType<typeof createServer> | null = null
  /** The in-flight initial replication connection, so shutdown and tests can await it. */
  private replicationStartup: Promise<void> = Promise.resolve()

  /** Cached project routes for multi-tenant JWT verification + tier limits. */
  private projectRoutes = new Map<string, ProjectRoute>()
  private routingCacheTimer: ReturnType<typeof setInterval> | null = null

  constructor(env: RealtimeEnv) {
    this.env = env
    this.channels = new ChannelManager()
    this.replication = new ReplicationListener({
      databaseUrl: env.databaseUrl,
      slotName: env.slotName,
      publicationName: env.publicationName,
      pollInterval: env.replicationPollInterval,
    })
    this.rlsFilter = new RlsFilter(env.databaseUrl)
  }

  async start(): Promise<void> {
    // HTTP server for health checks + WebSocket upgrade
    this.httpServer = createServer((req, res) => {
      const path = req.url?.split("?")[0] ?? ""
      // Liveness is "the process is up"; readiness is "replication is actually connected". They used
      // to be the same answer, which was fine only because the server refused to listen at all until
      // replication was up — so a database that was merely slow took the container down instead of
      // reporting itself as not ready yet.
      if (path === "/health" || path === "/health/live") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "ok" }))
        return
      }
      if (path === "/health/ready") {
        const ready = this.replication.isConnected()
        const unsupported = this.replication.unsupportedReason()
        res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            status: ready ? "ok" : unsupported ? "unsupported" : "waiting for database",
            // Named rather than implied: "not ready" that will never become ready is a different
            // operational fact from "not ready yet", and a gateway or dashboard has to tell them
            // apart to say anything useful.
            ...(unsupported !== null && { reason: unsupported }),
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    this.wss = new WebSocketServer({ server: this.httpServer })

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req)
    })

    // In multi-tenant mode, start routing table cache refresh
    if (this.env.multiTenant && this.env.routingTableUrl) {
      await this.refreshRoutingTable()
      this.routingCacheTimer = setInterval(() => {
        void this.refreshRoutingTable()
      }, this.env.routingTableRefreshMs)
    }

    // Start logical replication
    this.replication.onChange((change) => {
      void this.handleWalChange(change)
    })
    // A push can add, change or remove a field rule, and those are read from security
    // labels and cached. Re-read them rather than wait out the TTL, so a newly restricted
    // column stops being broadcast at the push rather than up to a TTL later.
    this.replication.onSchemaChange(() => {
      this.rlsFilter.invalidateFieldMasks()
    })

    // Listen first, then connect. The old order awaited replication before binding the port, so a
    // database that was not up yet meant no health endpoint to ask and — since the rejection reached
    // `main()` — no process either. Now the port opens, `/health/ready` answers 503 with the reason,
    // and replication keeps retrying behind it.
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.env.port, () => {
        console.log(`[realtime] WebSocket server listening on port ${this.env.port}${this.env.multiTenant ? " (multi-tenant)" : ""}`)
        resolve()
      })
    })

    this.replicationStartup = this.replication.start().catch((err) => {
      // A database that cannot do logical decoding is already reported by the listener, and the
      // service stays up serving presence and broadcast — only change-subscriptions are gone.
      if (err instanceof RealtimeUnsupportedError) return
      // Anything else non-transient is a broken process, not a missing feature.
      console.error("[realtime] replication failed to start:", err)
      process.exitCode = 1
    })
  }

  /** Resolves when the initial replication connection has settled — tests await this. */
  async waitForReplicationStartup(): Promise<void> {
    await this.replicationStartup
  }

  async stop(): Promise<void> {
    if (this.routingCacheTimer) {
      clearInterval(this.routingCacheTimer)
      this.routingCacheTimer = null
    }
    await this.replication.stop()
    await this.rlsFilter.shutdown()

    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close(1001, "server shutting down")
      }
      this.wss.close()
    }

    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  }

  // ─── Connection handling ─────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // In multi-tenant mode, extract project ref from header or query param
    let projectRef: string | null = null
    if (this.env.multiTenant) {
      projectRef =
        (req.headers["x-supatype-project"] as string | undefined) ??
        new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams.get("project") ??
        null

      if (!projectRef) {
        ws.close(4400, "Missing X-Supatype-Project header")
        return
      }

      // Check project exists and is active
      const route = this.projectRoutes.get(projectRef)
      if (!route || route.status !== "active") {
        ws.close(4404, "Project not found or inactive")
        return
      }

      // Check connection limit for this project's tier
      const limit = this.env.connectionLimits[route.tier] ?? 50
      const currentCount = this.channels.getProjectConnectionCount(projectRef)
      if (currentCount >= limit) {
        ws.close(4429, "Connection limit exceeded")
        return
      }
    }

    // Extract JWT — in multi-tenant mode, verify against per-project secret
    const claims = this.env.multiTenant && projectRef
      ? this.extractClaimsMultiTenant(req, projectRef)
      : this.extractClaims(req)

    if (this.env.secureChannels && !claims) {
      // Allow connection but require auth message before subscribing
    }

    const clientId = this.channels.addClient(ws, claims, projectRef)

    if (claims) {
      this.send(ws, { type: "system", status: "ok", message: "authenticated" })
    } else {
      this.send(ws, { type: "system", status: "ok", message: "connected — send auth message to authenticate" })
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data)) as ClientMessage
        this.handleMessage(clientId, msg)
      } catch {
        this.send(ws, { type: "system", status: "error", message: "invalid message format" })
      }
    })

    ws.on("close", () => {
      this.handleDisconnect(clientId)
    })

    ws.on("error", () => {
      this.handleDisconnect(clientId)
    })
  }

  private extractClaims(req: IncomingMessage): JwtClaims | null {
    // Try query parameter first
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const token = url.searchParams.get("token")
    if (token) {
      return verifyToken(token, this.env.jwtSecret)
    }

    // Try Authorization header
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith("Bearer ")) {
      return verifyToken(authHeader.slice(7), this.env.jwtSecret)
    }

    return null
  }

  // ─── Message handling ────────────────────────────────────────────────────

  private handleMessage(clientId: string, msg: ClientMessage): void {
    const client = this.channels.getClient(clientId)
    if (!client) return

    switch (msg.type) {
      case "auth":
        this.handleAuth(clientId, client, msg.token)
        break
      case "subscribe":
        this.handleSubscribe(clientId, client, msg)
        break
      case "unsubscribe":
        this.channels.unsubscribe(clientId, msg.channel)
        this.send(client.ws, { type: "system", status: "ok", message: `unsubscribed from ${msg.channel}` })
        break
      case "presence_track":
        this.handlePresenceTrack(clientId, client, msg.channel, msg.payload)
        break
      case "presence_untrack":
        this.handlePresenceUntrack(clientId, client, msg.channel)
        break
      case "broadcast":
        this.handleBroadcast(clientId, msg.channel, msg.event, msg.payload)
        break
    }
  }

  private handleAuth(clientId: string, client: ConnectedClient, token: string): void {
    const claims = verifyToken(token, this.env.jwtSecret)
    if (claims) {
      this.channels.setClientClaims(clientId, claims)
      this.send(client.ws, { type: "system", status: "ok", message: "authenticated" })
    } else {
      this.send(client.ws, { type: "system", status: "error", message: "invalid token" })
    }
  }

  private handleSubscribe(
    clientId: string,
    client: ConnectedClient,
    msg: { channel: string; event?: ChangeEvent | "*" | undefined; filter?: Record<string, string> | undefined },
  ): void {
    if (this.env.secureChannels && !client.claims) {
      this.send(client.ws, { type: "system", status: "error", message: "authenticate before subscribing" })
      return
    }

    const { schema, table } = ChannelManager.parseChannel(msg.channel)
    const subscription: Subscription = {
      channel: msg.channel,
      schema,
      table,
      event: msg.event ?? "*",
      filter: msg.filter ?? {},
    }

    this.channels.subscribe(clientId, subscription)
    this.send(client.ws, { type: "system", status: "ok", message: `subscribed to ${msg.channel}` })
  }

  private handleDisconnect(clientId: string): void {
    const client = this.channels.removeClient(clientId)
    if (!client) return

    // Broadcast presence leaves for any channels this client was in
    for (const [channel, entry] of client.presence) {
      const channelClients = this.channels.getChannelClients(channel)
      if (channelClients.length > 0) {
        const presenceMsg: ServerMessage = {
          type: "presence",
          channel,
          joins: [],
          leaves: [entry],
        }
        for (const { client: other } of channelClients) {
          this.send(other.ws, presenceMsg)
        }
      }
    }
  }

  // ─── Presence ────────────────────────────────────────────────────────────

  private handlePresenceTrack(
    clientId: string,
    client: ConnectedClient,
    channel: string,
    payload: Record<string, unknown>,
  ): void {
    const entry: PresenceEntry = {
      user_id: client.claims?.sub ?? "anonymous",
      ...payload,
    }

    this.channels.trackPresence(clientId, channel, entry)

    // Broadcast the join to all channel subscribers
    const channelClients = this.channels.getChannelClients(channel)
    const presenceMsg: ServerMessage = {
      type: "presence",
      channel,
      joins: [entry],
      leaves: [],
    }
    for (const { client: other } of channelClients) {
      this.send(other.ws, presenceMsg)
    }
  }

  private handlePresenceUntrack(
    clientId: string,
    client: ConnectedClient,
    channel: string,
  ): void {
    const entry = this.channels.untrackPresence(clientId, channel)
    if (!entry) return

    const channelClients = this.channels.getChannelClients(channel)
    const presenceMsg: ServerMessage = {
      type: "presence",
      channel,
      joins: [],
      leaves: [entry],
    }
    for (const { client: other } of channelClients) {
      this.send(other.ws, presenceMsg)
    }

    this.send(client.ws, { type: "system", status: "ok", message: `presence untracked from ${channel}` })
  }

  // ─── Broadcast ───────────────────────────────────────────────────────────

  private handleBroadcast(
    senderClientId: string,
    channel: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const broadcastMsg: ServerMessage = {
      type: "broadcast",
      channel,
      event,
      payload,
    }

    const channelClients = this.channels.getChannelClients(channel)
    for (const { clientId, client } of channelClients) {
      // Don't echo back to sender
      if (clientId !== senderClientId) {
        this.send(client.ws, broadcastMsg)
      }
    }
  }

  // ─── WAL change processing ──────────────────────────────────────────────

  private async handleWalChange(change: WalChange): Promise<void> {
    // In multi-tenant mode, filter WAL changes by project schema
    if (this.env.multiTenant) {
      const schema = change.schema

      // Filter out internal / system schemas (self-host + dedicated cloud)
      if (
        schema.endsWith("_auth") ||
        schema.endsWith("_internal") ||
        schema === "auth" ||
        schema === "_supatype" ||
        schema === "storage" ||
        schema === "extensions" ||
        schema.startsWith("pg_") ||
        schema === "_platform" ||
        schema === "cron"
      ) {
        return
      }

      // Legacy shared: schema name IS the project ref. Dedicated uses non-multiTenant path.
      const projectRef = schema
      const subscribers = this.channels.getSubscribersForProject(schema, change.table, projectRef)
      if (subscribers.length === 0) return

      const masked = await this.rlsFilter.maskedColumns(change.schema, change.table)

      for (const { client, subscription } of subscribers) {
        await this.deliverIfVisible(client, subscription, change, masked)
      }
      return
    }

    // Single-tenant mode — original behaviour
    const subscribers = this.channels.getSubscribers(change.schema, change.table)
    if (subscribers.length === 0) return

    const masked = await this.rlsFilter.maskedColumns(change.schema, change.table)

    for (const { client, subscription } of subscribers) {
      await this.deliverIfVisible(client, subscription, change, masked)
    }
  }

  /**
   * Decide whether one subscriber gets one change, and send it masked.
   *
   * Shared by both dispatch paths on purpose. The ordering here is security-relevant — the
   * subscriber's column filter must not be matched against values they may not read — and
   * two copies of it would be two chances to get it wrong.
   */
  private async deliverIfVisible(
    client: ConnectedClient,
    subscription: Subscription,
    change: WalChange,
    masked: Set<string>,
  ): Promise<void> {
    if (subscription.event !== "*" && subscription.event !== change.event) return

    // Cheap pass before the round trip, valid only when the filter names nothing
    // restricted. Filters that do are matched against the masked record instead, because
    // "did I receive this event" would otherwise answer a question about a hidden value.
    if (
      filterIsMaskSafe(subscription.filter, masked) &&
      !this.matchesFilter(change, subscription.filter)
    ) {
      return
    }

    // Row visibility plus field masking — what comes back is already masked, or nothing.
    const visible = await this.rlsFilter.visibleChange(client.claims, change)
    if (!visible) return

    // Authoritative filter pass, against what this subscriber is actually allowed to see.
    if (!this.matchesFilter(visible, subscription.filter)) return

    this.send(client.ws, {
      type: "change",
      channel: subscription.channel,
      event: change.event,
      payload: { old: visible.oldRecord, new: visible.newRecord },
      timestamp: change.commitTimestamp,
    })
  }


  /** Check if a change matches PostgREST-style column filters. */
  private matchesFilter(change: WalChange, filter: Record<string, string>): boolean {
    const record = change.newRecord ?? change.oldRecord
    if (!record) return true
    if (Object.keys(filter).length === 0) return true

    for (const [key, condition] of Object.entries(filter)) {
      const match = condition.match(/^(eq|neq|gt|gte|lt|lte)\.(.+)$/)
      if (!match) continue

      const [, op, value] = match
      const actual = String(record[key] ?? "")

      switch (op) {
        case "eq": if (actual !== value) return false; break
        case "neq": if (actual === value) return false; break
        case "gt": if (!(actual > value!)) return false; break
        case "gte": if (!(actual >= value!)) return false; break
        case "lt": if (!(actual < value!)) return false; break
        case "lte": if (!(actual <= value!)) return false; break
      }
    }

    return true
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  // ─── Multi-tenant helpers ───────────────────────────────────────────────

  /**
   * Refresh the local routing table cache from the control plane.
   * The routing table contains per-project JWT secrets and tier info.
   */
  private async refreshRoutingTable(): Promise<void> {
    if (!this.env.routingTableUrl) return

    try {
      const res = await fetch(this.env.routingTableUrl)
      if (!res.ok) {
        console.error(`[realtime] routing table refresh failed: ${res.status}`)
        return
      }

      const data = await res.json() as { routes: ProjectRoute[] }
      const newRoutes = new Map<string, ProjectRoute>()
      for (const route of data.routes) {
        newRoutes.set(route.ref, route)
      }
      this.projectRoutes = newRoutes
    } catch (err) {
      console.error("[realtime] routing table refresh error:", err)
    }
  }

  /**
   * Extract and verify JWT claims using the per-project secret (multi-tenant mode).
   */
  private extractClaimsMultiTenant(req: IncomingMessage, projectRef: string): JwtClaims | null {
    const route = this.projectRoutes.get(projectRef)
    if (!route) return null

    // Use the project's JWT secret
    const secret = route.jwtSecret

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const token = url.searchParams.get("token")
    if (token) return verifyToken(token, secret)

    const authHeader = req.headers.authorization
    if (authHeader?.startsWith("Bearer ")) return verifyToken(authHeader.slice(7), secret)

    return null
  }
}
