import type { WebSocket } from "ws"
import type { JwtClaims } from "./auth.js"
import type { Subscription, PresenceEntry } from "./types.js"
import {
  summariseChannels,
  summariseConnection,
  type ChannelSummary,
  type ConnectionSummary,
} from "./channel-summary.js"

/** The SDK and version a client named on its socket URL (`?client=supatype-js/0.4.1`). */
export interface ClientIdentity {
  name: string
  version: string | null
}

/** What a connection said about itself when it connected, for the inspector. */
export interface ConnectionMeta {
  client: ClientIdentity | null
  userAgent: string | null
}

/** Represents a connected WebSocket client. */
export interface ConnectedClient {
  ws: WebSocket
  claims: JwtClaims | null
  subscriptions: Map<string, Subscription>
  presence: Map<string, PresenceEntry>
  /** Project ref this client belongs to (multi-tenant mode). */
  projectRef: string | null
  /** When the socket connected, in epoch milliseconds. */
  connectedAt: number
  /** When the client last sent a frame, in epoch milliseconds, or null. */
  lastMessageAt: number | null
  client: ClientIdentity | null
  userAgent: string | null
}

const CLIENT_NAME_MAX = 64
const CLIENT_VERSION_MAX = 32
const USER_AGENT_MAX = 256

/**
 * `name/version` from the socket URL's `client` parameter, or a bare name, bounded.
 *
 * Client-supplied, so it is cut to a length that cannot bloat a listing, and it is only ever shown,
 * never trusted.
 */
export function parseClientParam(raw: string | null): ClientIdentity | null {
  const value = raw?.trim() ?? ""
  if (value === "") return null
  const slash = value.indexOf("/")
  const name = (slash === -1 ? value : value.slice(0, slash)).slice(0, CLIENT_NAME_MAX)
  const version = slash === -1 ? "" : value.slice(slash + 1).slice(0, CLIENT_VERSION_MAX)
  return { name, version: version === "" ? null : version }
}

/** The user agent a socket connected with, bounded like the client name, or null. */
export function boundedUserAgent(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ""
  return value === "" ? null : value.slice(0, USER_AGENT_MAX)
}

/** One page of connections for the inspector. */
export interface ConnectionPage {
  total: number
  connections: ConnectionSummary[]
  next: string | null
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
  /** When each channel last carried an event, per project, in epoch milliseconds. */
  private lastEvents = new Map<string | null, Map<string, number>>()

  /** Register a new WebSocket connection. Returns a connection ID. */
  addClient(
    ws: WebSocket,
    claims: JwtClaims | null,
    projectRef?: string | null,
    meta: ConnectionMeta = { client: null, userAgent: null },
  ): string {
    const id = String(++this.nextId)
    this.clients.set(id, {
      ws,
      claims,
      subscriptions: new Map(),
      presence: new Map(),
      projectRef: projectRef ?? null,
      connectedAt: Date.now(),
      lastMessageAt: null,
      client: meta.client,
      userAgent: meta.userAgent,
    })
    return id
  }

  /** Note that a client just sent a frame. */
  noteMessage(id: string): void {
    const client = this.clients.get(id)
    if (client) client.lastMessageAt = Date.now()
  }

  /** Note that `channel` just carried a change, a broadcast or a presence event. */
  touchChannel(channel: string, projectRef: string | null): void {
    let events = this.lastEvents.get(projectRef)
    if (!events) {
      events = new Map()
      this.lastEvents.set(projectRef, events)
    }
    events.set(channel, Date.now())
  }

  /**
   * Every channel with a live subscription in `projectRef`, busiest first, at most 1000.
   *
   * A channel exists only as the subscriptions held under its name, so this is the sum of every
   * connection's. Last-event times for channels nobody holds any more are dropped here, which is
   * what keeps that map from growing with every name ever used.
   */
  listChannels(projectRef: string | null): { channels: ChannelSummary[]; truncated: boolean } {
    const events = this.lastEvents.get(projectRef) ?? new Map<string, number>()
    const listed = summariseChannels(this.clientsOf(projectRef), events)
    for (const name of events.keys()) {
      if (!listed.names.has(name)) events.delete(name)
    }
    return { channels: listed.channels, truncated: listed.truncated }
  }

  /** Connections in `projectRef`, oldest first, `limit` at a time after the id `after`. */
  listConnections(opts: { limit: number; after: string | null; projectRef: string | null }): ConnectionPage {
    const all = [...this.clientsOf(opts.projectRef)].sort((a, b) => Number(a[0]) - Number(b[0]))
    const after = opts.after === null ? -Infinity : Number(opts.after)
    const remaining = all.filter(([id]) => Number(id) > after)
    const page = remaining.slice(0, opts.limit)
    const more = remaining.length > page.length
    return {
      total: all.length,
      connections: page.map(([id, client]) => summariseConnection(id, client)),
      next: more ? (page[page.length - 1]?.[0] ?? null) : null,
    }
  }

  /** Connections in `projectRef` (single-tenant: every connection, all of which carry null). */
  connectionCount(projectRef: string | null): number {
    let count = 0
    for (const client of this.clients.values()) {
      if (client.projectRef === projectRef) count++
    }
    return count
  }

  private *clientsOf(projectRef: string | null): Generator<[string, ConnectedClient]> {
    for (const entry of this.clients) {
      if (entry[1].projectRef === projectRef) yield entry
    }
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
      client.subscriptions.set(sub.channel, { ...sub, createdAt: sub.createdAt ?? Date.now() })
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
    return this.connectionCount(projectRef)
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
