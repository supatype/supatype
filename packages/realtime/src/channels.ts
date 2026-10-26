import type { WebSocket } from "ws"
import type { JwtClaims } from "./auth.js"
import type { Subscription, PresenceEntry } from "./types.js"

/** Represents a connected WebSocket client. */
export interface ConnectedClient {
  ws: WebSocket
  claims: JwtClaims | null
  subscriptions: Map<string, Subscription>
  presence: Map<string, PresenceEntry>
  /** Project ref this client belongs to (multi-tenant mode). */
  projectRef: string | null
}

/** A message that reaches a channel's other members rather than reading from the database. */
export type ChannelAction = "broadcast" | "presence_track" | "presence_untrack"

const ACTION_VERB: Record<ChannelAction, string> = {
  broadcast: "broadcasting",
  presence_track: "tracking presence",
  presence_untrack: "untracking presence",
}

/**
 * The verified claims `client` sends `action` to `channel` under, or why it may not send it.
 *
 * Two conditions. The client holds verified claims: any token signed with the project's secret,
 * the anon key included, since that is what a signed-out SDK client connects with. And it is a
 * member of the channel. Membership carries everything else: a subscription exists only once
 * `subscribe` accepted it, so whatever subscribe enforces holds here as well.
 *
 * Both used to be skipped. A socket with no token could broadcast to, and announce presence on,
 * any channel name without ever joining it.
 */
export function admitChannelAction(
  client: ConnectedClient,
  channel: string,
  action: ChannelAction,
): JwtClaims | string {
  const verb = ACTION_VERB[action]
  if (!client.claims) return `authenticate before ${verb}`
  if (!client.subscriptions.has(channel)) return `subscribe to ${channel} before ${verb}`
  return client.claims
}

/**
 * The identity a client's presence is recorded under: its verified subject, never its payload.
 *
 * A token with no subject (the anon key) is "anonymous", which names nobody and so cannot be
 * used to appear as somebody else.
 */
export function presenceKey(claims: JwtClaims): string {
  return typeof claims.sub === "string" && claims.sub !== "" ? claims.sub : "anonymous"
}

/**
 * Manages connected clients and their channel subscriptions.
 */
export class ChannelManager {
  /** All connected clients, keyed by a unique connection ID. */
  private clients = new Map<string, ConnectedClient>()
  private nextId = 0

  /** Register a new WebSocket connection. Returns a connection ID. */
  addClient(ws: WebSocket, claims: JwtClaims | null, projectRef?: string | null): string {
    const id = String(++this.nextId)
    this.clients.set(id, { ws, claims, subscriptions: new Map(), presence: new Map(), projectRef: projectRef ?? null })
    return id
  }

  /** Remove a client and clean up subscriptions. */
  removeClient(id: string): ConnectedClient | undefined {
    const client = this.clients.get(id)
    this.clients.delete(id)
    return client
  }

  /** Update a client's JWT claims (e.g., after auth message). */
  setClientClaims(id: string, claims: JwtClaims): void {
    const client = this.clients.get(id)
    if (client) client.claims = claims
  }

  getClient(id: string): ConnectedClient | undefined {
    return this.clients.get(id)
  }

  /** Subscribe a client to a channel. */
  subscribe(clientId: string, sub: Subscription): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.subscriptions.set(sub.channel, sub)
    }
  }

  /**
   * Unsubscribe a client from a channel, returning the presence it held there.
   *
   * Returned so the caller can tell the channel the member left. It used to be dropped here in
   * silence, and the others kept showing a member who had gone.
   */
  unsubscribe(clientId: string, channel: string): PresenceEntry | undefined {
    const client = this.clients.get(clientId)
    if (!client) return undefined
    const entry = client.presence.get(channel)
    client.subscriptions.delete(channel)
    client.presence.delete(channel)
    return entry
  }

  /**
   * Parse a channel name into schema and table.
   * Format: "schema:table" or just "table" (defaults to "public").
   */
  static parseChannel(channel: string): { schema: string; table: string } {
    const parts = channel.split(":")
    if (parts.length >= 2) {
      return { schema: parts[0]!, table: parts[1]! }
    }
    return { schema: "public", table: parts[0]! }
  }

  /**
   * Which schema and table a subscribe message concerns.
   *
   * What the subscriber said wins; the channel name is the fallback for clients that predate
   * sending it. The channel is a *name* for a subscription, and reading it as a statement about
   * the table is a guess that is right only when the two happen to coincide -- which they do for
   * `from(table).subscribe()` and do not for a channel named after its purpose. A subscription
   * registered under the wrong table matches no change, and the only symptom is silence on a
   * socket that has already reported SUBSCRIBED.
   *
   * Exported so the rule has one home. A test that restates it passes against a server that does
   * something else, which is how this survived in the first place.
   */
  static resolveTarget(msg: {
    channel: string
    table?: string | undefined
    schema?: string | undefined
  }): { schema: string; table: string } {
    const parsed = ChannelManager.parseChannel(msg.channel)
    return { schema: msg.schema ?? parsed.schema, table: msg.table ?? parsed.table }
  }

  /**
   * Get all clients subscribed to a given schema.table,
   * optionally filtered by event type.
   */
  getSubscribers(schema: string, table: string): Array<{ clientId: string; client: ConnectedClient; subscription: Subscription }> {
    const results: Array<{ clientId: string; client: ConnectedClient; subscription: Subscription }> = []

    for (const [clientId, client] of this.clients) {
      for (const sub of client.subscriptions.values()) {
        if (sub.schema === schema && sub.table === table) {
          results.push({ clientId, client, subscription: sub })
        }
      }
    }

    return results
  }

  /**
   * Get all clients in a channel (for broadcast/presence), within one project.
   *
   * A channel name is chosen by the client, so on a shared instance two projects can pick the
   * same one. Scoped by project so one project's broadcast never reaches another's members.
   */
  getChannelClients(
    channel: string,
    projectRef: string | null,
  ): Array<{ clientId: string; client: ConnectedClient }> {
    const results: Array<{ clientId: string; client: ConnectedClient }> = []

    for (const [clientId, client] of this.clients) {
      if (client.projectRef !== projectRef) continue
      if (client.subscriptions.has(channel)) {
        results.push({ clientId, client })
      }
    }

    return results
  }

  /** Track presence for a client in a channel. */
  trackPresence(clientId: string, channel: string, entry: PresenceEntry): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.presence.set(channel, entry)
    }
  }

  /** Remove presence tracking for a client in a channel. */
  untrackPresence(clientId: string, channel: string): PresenceEntry | undefined {
    const client = this.clients.get(clientId)
    if (!client) return undefined
    const entry = client.presence.get(channel)
    client.presence.delete(channel)
    return entry
  }

  /** Get all presence entries for a channel. */
  getPresence(channel: string): PresenceEntry[] {
    const entries: PresenceEntry[] = []
    for (const client of this.clients.values()) {
      const entry = client.presence.get(channel)
      if (entry) entries.push(entry)
    }
    return entries
  }

  // ─── Multi-tenant helpers ───────────────────────────────────────────────

  /** Count connections for a specific project (multi-tenant mode). */
  getProjectConnectionCount(projectRef: string): number {
    let count = 0
    for (const client of this.clients.values()) {
      if (client.projectRef === projectRef) count++
    }
    return count
  }

  /** Set the project ref for a client. */
  setClientProjectRef(id: string, projectRef: string): void {
    const client = this.clients.get(id)
    if (client) client.projectRef = projectRef
  }

  /**
   * Get subscribers for a schema.table, optionally scoped to a project ref.
   * In multi-tenant mode, only returns subscribers whose projectRef matches
   * the schema prefix of the change.
   */
  getSubscribersForProject(
    schema: string,
    table: string,
    projectRef: string | null,
  ): Array<{ clientId: string; client: ConnectedClient; subscription: Subscription }> {
    const results: Array<{ clientId: string; client: ConnectedClient; subscription: Subscription }> = []

    for (const [clientId, client] of this.clients) {
      // In multi-tenant mode, only match clients for this project
      if (projectRef !== null && client.projectRef !== projectRef) continue

      for (const sub of client.subscriptions.values()) {
        if (sub.schema === schema && sub.table === table) {
          results.push({ clientId, client, subscription: sub })
        }
      }
    }

    return results
  }
}
