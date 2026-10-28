import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import { createServer } from "node:http"
import type { RealtimeEnv } from "./env.js"
import { verifyToken, type JwtClaims } from "./auth.js"
import {
  ChannelManager,
  admitChannelAction,
  boundedUserAgent,
  parseClientParam,
  presenceKey,
  type ChannelAction,
  type ClientSocket,
  type ConnectedClient,
} from "./channels.js"
import { ReplicationListener } from "./replication.js"
import { parseClientMessage } from "./client-message.js"
import { isArrayOf, isShape, isString, type FromShape } from "./json.js"
import { RealtimeUnsupportedError } from "./capability.js"
import { RlsFilter } from "./rls.js"
import { filterIsMaskSafe } from "./field-mask.js"
import { matchesFilter, unreadableCondition } from "./filter-match.js"
import { TOKEN_EXPIRED_CLOSE, TokenExpiry } from "./token-expiry.js"
import { AdminServer } from "./admin/server.js"
import { Tap, type ChangeRecord } from "./admin/tap.js"
import type { BroadcastInput } from "./admin/broadcast.js"
import type {
  ClientMessage,
  ServerMessage,
  Subscription,
  WalChange,
  ChangeEvent,
  PresenceEntry,
  PresenceTrackMessage,
  BroadcastMessage,
} from "./types.js"

/** What a server can be given instead of building its own, for embedders and tests. */
export interface RealtimeServerDeps {
  rlsFilter?: RlsFilter | undefined
  /** The inspector's message tap; one is created when not given. */
  tap?: Tap | undefined
}

/** One subscriber of one table, as the dispatch loop walks them. */
interface SubscriberEntry {
  clientId: string
  client: ConnectedClient
  subscription: Subscription
}

/** Schemas whose changes a shared instance never forwards: platform and service internals. */
function isInternalSchema(schema: string): boolean {
  return (
    schema.endsWith("_auth") ||
    schema.endsWith("_internal") ||
    schema === "auth" ||
    schema === "_supatype" ||
    schema === "storage" ||
    schema === "extensions" ||
    schema.startsWith("pg_") ||
    schema === "_platform" ||
    schema === "cron"
  )
}

const PROJECT_ROUTE = { ref: isString, jwtSecret: isString, tier: isString, status: isString } as const

/** Cached routing table entry for multi-tenant mode. */
type ProjectRoute = FromShape<typeof PROJECT_ROUTE>

/** What the control plane's routing table API answers with. */
const isRoutingTable = isShape({ routes: isArrayOf(isShape(PROJECT_ROUTE)) })

/** The `X-Supatype-Project` header, when it is sent once. */
function projectHeader(req: IncomingMessage): string | undefined {
  const header = req.headers["x-supatype-project"]
  return typeof header === "string" ? header : undefined
}

export class RealtimeServer {
  private env: RealtimeEnv
  private wss: WebSocketServer | null = null
  private channels: ChannelManager
  private replication: ReplicationListener
  private rlsFilter: RlsFilter
  private httpServer: ReturnType<typeof createServer> | null = null
  /** The inspector's internal admin API, when `adminPort` is set. */
  private admin: AdminServer | null = null
  /** The inspector's message tap. Inactive, and costing one boolean check, until a stream opens. */
  private readonly tap: Tap
  /** The in-flight initial replication connection, so shutdown and tests can await it. */
  private replicationStartup: Promise<void> = Promise.resolve()
  /** Set by `stop()`, so a startup abandoned by the shutdown is not reported as a failure. */
  private stopping = false

  /** Cached project routes for multi-tenant JWT verification + tier limits. */
  private projectRoutes = new Map<string, ProjectRoute>()
  private routingCacheTimer: ReturnType<typeof setInterval> | null = null
  /** Closes each authenticated socket when its token expires. */
  private readonly tokenExpiry = new TokenExpiry()

  constructor(env: RealtimeEnv, deps: RealtimeServerDeps = {}) {
    this.env = env
    this.tap = deps.tap ?? new Tap()
    this.channels = new ChannelManager()
    this.replication = new ReplicationListener({
      databaseUrl: env.databaseUrl,
      slotName: env.slotName,
      publicationName: env.publicationName,
      pollInterval: env.replicationPollInterval,
    })
    this.rlsFilter = deps.rlsFilter ?? new RlsFilter(env.databaseUrl, env.logLevel)
  }

  async start(): Promise<void> {
    // HTTP server for health checks + WebSocket upgrade
    this.httpServer = createServer((req, res) => {
      const path = req.url?.split("?")[0] ?? ""
      // Liveness is "the process is up"; readiness is "replication is actually connected". They used
      // to be the same answer, which was fine only because the server refused to listen at all until
      // replication was up: so a database that was merely slow took the container down instead of
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
      void this.dispatchChange(change)
    })
    // A push can add, change or remove a field rule, and those are read from security
    // labels and cached, as are table shapes (keys, columns, predicates). Re-read them rather
    // than wait out the TTL, so a newly restricted column stops being broadcast at the push
    // rather than up to a TTL later.
    this.replication.onSchemaChange(() => {
      this.rlsFilter.invalidateCatalogs()
    })

    // Listen first, then connect. The old order awaited replication before binding the port, so a
    // database that was not up yet meant no health endpoint to ask and, since the rejection reached
    // `main()`: no process either. Now the port opens, `/health/ready` answers 503 with the reason,
    // and replication keeps retrying behind it.
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.env.port, () => {
        console.log(`[realtime] WebSocket server listening on port ${this.env.port}${this.env.multiTenant ? " (multi-tenant)" : ""}`)
        resolve()
      })
    })
    await this.startAdmin()

    this.replicationStartup = this.replication.start().catch((err) => {
      // A database that cannot do logical decoding is already reported by the listener, and the
      // service stays up serving presence and broadcast, only change-subscriptions are gone.
      if (err instanceof RealtimeUnsupportedError) return
      // Stopped while still waiting for the database: the retry hands back its last error, and
      // that is a shutdown, not a failure. Treating it as one marked a clean stop as exit code 1.
      if (this.stopping) return
      // Anything else non-transient is a broken process, not a missing feature.
      console.error("[realtime] replication failed to start:", err)
      process.exitCode = 1
    })
  }

  /** The admin listener, on its own port and only when one is configured. */
  private async startAdmin(): Promise<void> {
    const adminPort = this.env.adminPort ?? null
    if (adminPort === null) return
    this.admin = new AdminServer({
      channels: this.channels,
      tap: this.tap,
      rules: this.rlsFilter,
      service: () => ({ ready: this.replication.isConnected(), reason: this.replication.unsupportedReason() }),
      connectionLimit: (projectRef) => this.connectionLimitFor(projectRef),
      secretFor: (projectRef) => this.jwtSecretFor(projectRef),
      multiTenant: this.env.multiTenant,
      broadcast: (input, projectRef) => this.studioBroadcast(input, projectRef),
    })
    await this.admin.start(adminPort)
  }

  /** Resolves when the initial replication connection has settled, tests await this. */
  async waitForReplicationStartup(): Promise<void> {
    await this.replicationStartup
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.routingCacheTimer) {
      clearInterval(this.routingCacheTimer)
      this.routingCacheTimer = null
    }
    this.tokenExpiry.clear()
    await this.admin?.stop()
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
        projectHeader(req) ??
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

    }

    const limit = this.connectionLimitFor(projectRef)
    if (limit !== null && this.channels.connectionCount(projectRef) >= limit) {
      ws.close(4429, "Connection limit exceeded")
      return
    }

    // Extract JWT: in multi-tenant mode, verify against per-project secret. A socket without one
    // may connect, and must send an `auth` message before it can subscribe.
    const claims = this.extractClaims(req, this.jwtSecretFor(projectRef))

    const clientId = this.channels.addClient(ws, claims, projectRef, {
      client: parseClientParam(new URL(req.url ?? "/", "http://socket.local").searchParams.get("client")),
      userAgent: boundedUserAgent(req.headers["user-agent"]),
    })

    // Closed rather than dropped back to anonymous when its token runs out, so the client knows to
    // reconnect, which resolves its token again: one holding a refreshed token comes back with it,
    // and one holding only the expired token connects unauthenticated and is not closed again.
    this.tokenExpiry.add(clientId, () => ws.close(TOKEN_EXPIRED_CLOSE, "token expired"))

    if (claims) {
      this.tokenExpiry.watch(clientId, claims)
      this.send(ws, { type: "system", status: "ok", message: "authenticated" })
    } else {
      this.send(ws, { type: "system", status: "ok", message: "connected, send auth message to authenticate" })
    }

    ws.on("message", (data) => {
      this.channels.noteMessage(clientId)
      try {
        const msg = parseClientMessage(String(data))
        if (msg === null) throw new Error("not a client message")
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

  /**
   * The most sockets `projectRef` may hold, or null for no limit.
   *
   * Multi-tenant: by the project's tier. Single-tenant: `CONNECTION_LIMIT`, which is how each Cloud
   * project's own realtime is limited, and unset on self-host.
   */
  private connectionLimitFor(projectRef: string | null): number | null {
    if (!this.env.multiTenant) return this.env.connectionLimit ?? null
    const tier = projectRef === null ? undefined : this.projectRoutes.get(projectRef)?.tier
    return this.env.connectionLimits[tier ?? "free"] ?? 50
  }

  /** The claims of the token the upgrade request carries, verified with `secret`. */
  private extractClaims(req: IncomingMessage, secret: string | null): JwtClaims | null {
    if (secret === null) return null
    // Try query parameter first
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const token = url.searchParams.get("token")
    if (token) {
      return verifyToken(token, secret)
    }

    // Try Authorization header
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith("Bearer ")) {
      return verifyToken(authHeader.slice(7), secret)
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
        this.handleUnsubscribe(clientId, client, msg.channel)
        break
      case "presence_track":
      case "presence_untrack":
      case "broadcast":
        this.handleChannelAction(clientId, client, msg)
        break
    }
  }

  /**
   * Broadcast and presence, for a client allowed to send them.
   *
   * Refused with an error frame otherwise, the same shape subscribe refuses with, so a client
   * learns why nothing happened rather than reading silence as an empty room.
   */
  private handleChannelAction(
    clientId: string,
    client: ConnectedClient,
    msg: Extract<ClientMessage, { type: ChannelAction }>,
  ): void {
    const admitted = admitChannelAction(client, msg.channel, msg.type)
    if (typeof admitted === "string") {
      this.refuse(client, msg.channel, admitted)
      return
    }
    switch (msg.type) {
      case "presence_track":
        this.handlePresenceTrack(clientId, client, admitted, msg)
        break
      case "presence_untrack":
        this.handlePresenceUntrack(clientId, client, msg.channel)
        break
      case "broadcast":
        this.handleBroadcast(clientId, client, msg)
        break
    }
  }

  /**
   * Refuses something asked of one channel, naming it. The client reads an error that names no
   * channel as about the whole socket, so a refusal without one put every healthy channel the
   * client had into CHANNEL_ERROR.
   */
  private refuse(client: ConnectedClient, channel: string, message: string): void {
    this.send(client.ws, { type: "system", status: "error", message, channel })
  }

  private handleUnsubscribe(clientId: string, client: ConnectedClient, channel: string): void {
    const entry = this.channels.unsubscribe(clientId, channel)
    if (entry) this.announcePresence(client, channel, { joins: [], leaves: [entry] })
    this.send(client.ws, { type: "system", status: "ok", message: `unsubscribed from ${channel}` })
  }

  private handleAuth(clientId: string, client: ConnectedClient, token: string): void {
    const secret = this.jwtSecretFor(client.projectRef)
    const claims = secret === null ? null : verifyToken(token, secret)
    if (claims) {
      this.channels.setClientClaims(clientId, claims)
      this.tokenExpiry.watch(clientId, claims)
      this.send(client.ws, { type: "system", status: "ok", message: "authenticated" })
    } else {
      this.send(client.ws, { type: "system", status: "error", message: "invalid token" })
    }
  }

  private handleSubscribe(
    clientId: string,
    client: ConnectedClient,
    msg: {
      channel: string
      event?: ChangeEvent | "*" | undefined
      table?: string | undefined
      schema?: string | undefined
      filter?: Record<string, string> | undefined
    },
  ): void {
    if (this.env.secureChannels && !client.claims) {
      this.refuse(client, msg.channel, "authenticate before subscribing")
      return
    }

    // Refused rather than stored. A condition the matcher cannot read used to be skipped, which
    // widened the subscription to every row the other conditions let through.
    const unreadable = unreadableCondition(msg.filter ?? {})
    if (unreadable !== null) {
      const message = `invalid filter ${unreadable}: expected column=op.value with op one of eq, neq, gt, gte, lt, lte`
      this.refuse(client, msg.channel, message)
      return
    }

    // What the subscriber said, and the channel name only when they said nothing.
    //
    // Reading the table out of the channel name is a guess that happens to be right when the
    // channel is named after its table, which is what `from(table).subscribe()` produces. A client
    // naming its channel anything else got a subscription against a table no change can match, and
    // the only symptom was silence on a socket that had reported SUBSCRIBED.
    //
    // The fallback stays for clients that predate `table` being sent at all: an old client and a
    // new server behave exactly as they did.
    const subscription: Subscription = {
      channel: msg.channel,
      ...ChannelManager.resolveTarget(msg),
      event: msg.event ?? "*",
      filter: msg.filter ?? {},
    }

    this.channels.subscribe(clientId, subscription)
    this.send(client.ws, { type: "system", status: "ok", message: `subscribed to ${msg.channel}` })
    this.sendPresenceState(client, msg.channel)
  }

  /**
   * Tell a client that just joined `channel` who is already tracked there.
   *
   * Presence used to be announced only as it changed, so a member learned of everyone who joined
   * after it and of nobody who was there first: three people in a lobby read "3 here", "2 here"
   * and "1 here". The members already present arrive as joins, the same frame every later change
   * uses, which is what Supabase's `presence_state` does for its newcomers. Sent after the join is
   * accepted, so the client already holds the channel the frame names.
   */
  private sendPresenceState(client: ConnectedClient, channel: string): void {
    const joins = this.channels.getPresence(channel, client.projectRef)
    if (joins.length === 0) return
    this.send(client.ws, { type: "presence", channel, joins, leaves: [] })
  }

  private handleDisconnect(clientId: string): void {
    this.tokenExpiry.remove(clientId)
    const client = this.channels.removeClient(clientId)
    if (!client) return

    // Broadcast presence leaves for any channels this client was in
    for (const [channel, entry] of client.presence) {
      this.announcePresence(client, channel, { joins: [], leaves: [entry] })
    }
  }

  // ─── Presence ────────────────────────────────────────────────────────────

  /** Tell every member of `channel` in `client`'s project who joined and who left. */
  private announcePresence(
    client: ConnectedClient,
    channel: string,
    change: { joins: PresenceEntry[]; leaves: PresenceEntry[] },
  ): void {
    const frame = JSON.stringify({ type: "presence", channel, ...change } satisfies ServerMessage)
    const members = this.channels.getChannelClients(channel, client.projectRef)
    for (const { client: other } of members) {
      this.sendFrame(other.ws, frame)
    }
    this.channels.touchChannel(channel, client.projectRef)
    if (this.tap.active) this.tapPresence(channel, change, members.length)
  }

  private tapPresence(
    channel: string,
    change: { joins: PresenceEntry[]; leaves: PresenceEntry[] },
    recipients: number,
  ): void {
    for (const entry of change.joins) this.tap.presence({ channel, kind: "join", userId: entry.user_id, recipients })
    for (const entry of change.leaves) this.tap.presence({ channel, kind: "leave", userId: entry.user_id, recipients })
  }

  private handlePresenceTrack(
    clientId: string,
    client: ConnectedClient,
    claims: JwtClaims,
    msg: PresenceTrackMessage,
  ): void {
    // The verified subject is written last, so a payload carrying its own `user_id` cannot
    // replace it. Spread the other way round, any member could appear as any other.
    const entry: PresenceEntry = { ...msg.payload, user_id: presenceKey(claims) }

    this.channels.trackPresence(clientId, msg.channel, entry)
    this.announcePresence(client, msg.channel, { joins: [entry], leaves: [] })
  }

  private handlePresenceUntrack(
    clientId: string,
    client: ConnectedClient,
    channel: string,
  ): void {
    const entry = this.channels.untrackPresence(clientId, channel)
    if (!entry) return

    this.announcePresence(client, channel, { joins: [], leaves: [entry] })
    this.send(client.ws, { type: "system", status: "ok", message: `presence untracked from ${channel}` })
  }

  // ─── Broadcast ───────────────────────────────────────────────────────────

  private handleBroadcast(
    senderClientId: string,
    sender: ConnectedClient,
    msg: BroadcastMessage,
  ): void {
    this.fanOutBroadcast(msg, sender.projectRef, senderClientId)
  }

  /** A broadcast from the Studio tester: every member hears it, since no socket sent it. */
  private studioBroadcast(input: BroadcastInput, projectRef: string | null): number {
    return this.fanOutBroadcast(input, projectRef, null)
  }

  /**
   * Send a broadcast to every member of its channel but its sender, and return how many it reached.
   *
   * The one fan-out for client broadcasts and the Studio tester, so a test broadcast reaches exactly
   * who a client's would. The frame is serialised once, not once per member.
   */
  private fanOutBroadcast(
    msg: { channel: string; event: string; payload: Record<string, unknown> },
    projectRef: string | null,
    senderClientId: string | null,
  ): number {
    const { channel, event, payload } = msg
    const frame = JSON.stringify({ type: "broadcast", channel, event, payload } satisfies ServerMessage)
    let recipients = 0
    for (const { clientId, client } of this.channels.getChannelClients(channel, projectRef)) {
      if (clientId === senderClientId) continue
      if (this.sendFrame(client.ws, frame)) recipients++
    }
    this.channels.touchChannel(channel, projectRef)
    if (this.tap.active) {
      this.tap.broadcast({
        channel,
        event,
        origin: senderClientId === null ? "studio" : "client",
        senderConnectionId: senderClientId,
        recipients,
        frame: recipients > 0 ? frame : null,
        payload,
      })
    }
    return recipients
  }

  // ─── WAL change processing ──────────────────────────────────────────────

  /**
   * Deliver one WAL change to every subscriber allowed to see it.
   *
   * Called for each change replication decodes; public so an embedder or a test can feed changes
   * without a replication slot.
   */
  async dispatchChange(change: WalChange): Promise<void> {
    const subscribers = this.subscribersOf(change)
    if (subscribers.length === 0) return

    // The inspector, when one is open. With none, this is the whole of its cost.
    const record = this.tap.active
      ? this.tap.begin(change, subscribers.map((s) => s.subscription.channel))
      : null

    const masked = await this.rlsFilter.maskedColumns(change.schema, change.table)

    for (const { clientId, client, subscription } of subscribers) {
      await this.deliverIfVisible(clientId, client, subscription, change, masked, record)
    }
    if (record) this.tap.end(record)
  }

  /**
   * Who subscribes to the change's table. A shared instance reads the project from the schema
   * (legacy shared: the schema name is the project ref) and never forwards internal schemas.
   */
  private subscribersOf(change: WalChange): SubscriberEntry[] {
    if (!this.env.multiTenant) return this.channels.getSubscribers(change.schema, change.table)
    if (isInternalSchema(change.schema)) return []
    return this.channels.getSubscribersForProject(change.schema, change.table, change.schema)
  }

  /**
   * Decide whether one subscriber gets one change, and send it masked.
   *
   * Shared by both dispatch paths on purpose. The ordering here is security-relevant, the
   * subscriber's column filter must not be matched against values they may not read, and
   * two copies of it would be two chances to get it wrong.
   */
  private async deliverIfVisible(
    clientId: string,
    client: ConnectedClient,
    subscription: Subscription,
    change: WalChange,
    masked: Set<string>,
    record: ChangeRecord | null,
  ): Promise<void> {
    // Cheap pass before the round trip, valid only when the filter names nothing
    // restricted. Filters that do are matched against the masked record instead, because
    // "did I receive this event" would otherwise answer a question about a hidden value.
    if (
      (subscription.event !== "*" && subscription.event !== change.event) ||
      (filterIsMaskSafe(subscription.filter, masked) && !matchesFilter(change, subscription.filter))
    ) {
      record?.unmatched()
      return
    }

    // Row visibility plus field masking, what comes back is already masked, or nothing.
    const verdict = await this.rlsFilter.judgeForDelivery(client.claims, change)
    if ("refused" in verdict) {
      this.rlsFilter.logRefusal(client.claims, change, verdict.refused)
      record?.refused(clientId, subscription.channel, verdict.refused)
      return
    }
    const visible = verdict.send

    // Authoritative filter pass, against what this subscriber is actually allowed to see.
    if (!matchesFilter(visible, subscription.filter)) {
      record?.unmatched()
      return
    }

    const frame = this.send(client.ws, {
      type: "change",
      channel: subscription.channel,
      event: change.event,
      payload: { old: visible.oldRecord, new: visible.newRecord },
      ...(Object.keys(visible.exactColumns).length > 0
        ? { exactColumns: visible.exactColumns }
        : {}),
      timestamp: change.commitTimestamp,
    })
    if (frame === null) return
    this.channels.touchChannel(subscription.channel, client.projectRef)
    record?.delivered({ connectionId: clientId, channel: subscription.channel, frame, visible, redacted: verdict.redacted })
  }

  /** Send `msg`, returning the frame it sent, or null when the socket was not open. */
  private send(ws: ClientSocket, msg: ServerMessage): string | null {
    const frame = JSON.stringify(msg)
    return this.sendFrame(ws, frame) ? frame : null
  }

  /** Send an already-serialised frame, reporting whether the socket was open to take it. */
  private sendFrame(ws: ClientSocket, frame: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    ws.send(frame)
    return true
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

      const data = await res.json()
      if (!isRoutingTable(data)) {
        console.error("[realtime] routing table refresh failed: the answer is not a routing table")
        return
      }
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
   * The secret a client's tokens are verified with: its project's on a shared instance.
   *
   * The `auth` message used to verify against the instance-wide secret even in multi-tenant mode,
   * so a client of one project could authenticate with a token that project never issued.
   */
  private jwtSecretFor(projectRef: string | null): string | null {
    if (!this.env.multiTenant) return this.env.jwtSecret
    if (projectRef === null) return null
    return this.projectRoutes.get(projectRef)?.jwtSecret ?? null
  }
}
