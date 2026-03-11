import type { WebSocket } from "ws"
import type { JwtClaims } from "./auth.js"
import type { Subscription, PresenceEntry } from "./types.js"

/** Represents a connected WebSocket client. */
export interface ConnectedClient {
  ws: WebSocket
  claims: JwtClaims | null
  subscriptions: Map<string, Subscription>
  presence: Map<string, PresenceEntry>
}

/**
 * Manages connected clients and their channel subscriptions.
 */
export class ChannelManager {
  /** All connected clients, keyed by a unique connection ID. */
  private clients = new Map<string, ConnectedClient>()
  private nextId = 0

  /** Register a new WebSocket connection. Returns a connection ID. */
  addClient(ws: WebSocket, claims: JwtClaims | null): string {
    const id = String(++this.nextId)
    this.clients.set(id, { ws, claims, subscriptions: new Map(), presence: new Map() })
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

  /** Unsubscribe a client from a channel. */
  unsubscribe(clientId: string, channel: string): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.subscriptions.delete(channel)
      client.presence.delete(channel)
    }
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

  /** Get all clients in a channel (for broadcast/presence). */
  getChannelClients(channel: string): Array<{ clientId: string; client: ConnectedClient }> {
    const results: Array<{ clientId: string; client: ConnectedClient }> = []

    for (const [clientId, client] of this.clients) {
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
}
