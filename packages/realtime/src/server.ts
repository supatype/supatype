import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import { createServer } from "node:http"
import type { RealtimeEnv } from "./env.js"
import { verifyToken, type JwtClaims } from "./auth.js"
import { ChannelManager, type ConnectedClient } from "./channels.js"
import { ReplicationListener } from "./replication.js"
import { RlsFilter } from "./rls.js"
import type {
  ClientMessage,
  ServerMessage,
  Subscription,
  WalChange,
  ChangeEvent,
  PresenceEntry,
} from "./types.js"

export class RealtimeServer {
  private env: RealtimeEnv
  private wss: WebSocketServer | null = null
  private channels: ChannelManager
  private replication: ReplicationListener
  private rlsFilter: RlsFilter
  private httpServer: ReturnType<typeof createServer> | null = null

  constructor(env: RealtimeEnv) {
    this.env = env
    this.channels = new ChannelManager()
    this.replication = new ReplicationListener({
      databaseUrl: env.databaseUrl,
      slotName: env.slotName,
      pollInterval: env.replicationPollInterval,
    })
    this.rlsFilter = new RlsFilter(env.databaseUrl)
  }

  async start(): Promise<void> {
    // HTTP server for health checks + WebSocket upgrade
    this.httpServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "ok" }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    this.wss = new WebSocketServer({ server: this.httpServer })

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req)
    })

    // Start logical replication
    this.replication.onChange((change) => {
      void this.handleWalChange(change)
    })
    await this.replication.start()

    // Listen on configured port
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.env.port, () => {
        console.log(`[realtime] WebSocket server listening on port ${this.env.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
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
    // Extract JWT from query string (?token=xxx) or Authorization header
    const claims = this.extractClaims(req)

    if (this.env.secureChannels && !claims) {
      // Allow connection but require auth message before subscribing
    }

    const clientId = this.channels.addClient(ws, claims)

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
    const subscribers = this.channels.getSubscribers(change.schema, change.table)
    if (subscribers.length === 0) return

    for (const { client, subscription } of subscribers) {
      // Check event filter
      if (subscription.event !== "*" && subscription.event !== change.event) {
        continue
      }

      // Check column filters
      if (!this.matchesFilter(change, subscription.filter)) {
        continue
      }

      // RLS check — verify the subscriber can see this record
      const canSee = await this.rlsFilter.canSee(client.claims, change)
      if (!canSee) continue

      // Send the change event
      const msg: ServerMessage = {
        type: "change",
        channel: subscription.channel,
        event: change.event,
        payload: {
          old: change.oldRecord,
          new: change.newRecord,
        },
        timestamp: change.commitTimestamp,
      }
      this.send(client.ws, msg)
    }
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
}
