import type { ConnectedClient, ClientIdentity } from "./channels.js"
import type { ChangeEvent } from "./types.js"

/**
 * What the inspector is told about channels and connections, built from the registry.
 *
 * Kept apart from `ChannelManager` because it is a view, not state: it decides what leaves the
 * process, and so what does not. Filter values, socket URLs (which carry the access token), claims
 * other than `sub` and `role`, and addresses never appear here.
 */

/** Most channels one listing returns; the rest are reported as `truncated`. */
export const CHANNEL_LIST_MAX = 1000

export interface ChannelTarget {
  schema: string
  table: string
  event: ChangeEvent | "*"
  /** True when any subscriber on this target has a column filter. Filter values are never returned. */
  filtered: boolean
  subscribers: number
}

export interface ChannelSummary {
  name: string
  /** Connections holding a subscription under this channel name. */
  subscribers: number
  /** Presence entries tracked in this channel. */
  presence: number
  /** One row per distinct (schema, table, event) subscribed under this name. */
  targets: ChannelTarget[]
  /** Earliest creation time of the live subscriptions under this name (ISO 8601). */
  createdAt: string
  /** Last change, broadcast or presence event delivered on this channel, or null. */
  lastEventAt: string | null
}

export interface ConnectionSummary {
  id: string
  /** JWT `sub`, or null when the socket has not authenticated or its token names nobody. */
  userId: string | null
  /** JWT `role`, or null. */
  role: string | null
  connectedAt: string
  /** Last frame received from the client, or null. */
  lastMessageAt: string | null
  channels: string[]
  client: ClientIdentity | null
  userAgent: string | null
}

/** A channel while it is being counted: targets keyed so equal ones merge. */
interface ChannelTally {
  name: string
  subscribers: number
  presence: number
  targets: Map<string, ChannelTarget>
  createdAt: number
}

const iso = (ms: number): string => new Date(ms).toISOString()

function tally(channels: Map<string, ChannelTally>, client: ConnectedClient): void {
  for (const sub of client.subscriptions.values()) {
    let entry = channels.get(sub.channel)
    if (!entry) {
      entry = { name: sub.channel, subscribers: 0, presence: 0, targets: new Map(), createdAt: Infinity }
      channels.set(sub.channel, entry)
    }
    entry.subscribers++
    if (client.presence.has(sub.channel)) entry.presence++
    entry.createdAt = Math.min(entry.createdAt, sub.createdAt ?? client.connectedAt)

    const key = JSON.stringify([sub.schema, sub.table, sub.event])
    const target = entry.targets.get(key) ?? { schema: sub.schema, table: sub.table, event: sub.event, filtered: false, subscribers: 0 }
    target.subscribers++
    target.filtered ||= Object.keys(sub.filter).length > 0
    entry.targets.set(key, target)
  }
}

function byTarget(a: ChannelTarget, b: ChannelTarget): number {
  return a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table) || a.event.localeCompare(b.event)
}

/** Every channel the clients hold, busiest first then by name, capped at {@link CHANNEL_LIST_MAX}. */
export function summariseChannels(
  clients: Iterable<[string, ConnectedClient]>,
  lastEvents: ReadonlyMap<string, number>,
): { channels: ChannelSummary[]; truncated: boolean; names: Set<string> } {
  const tallies = new Map<string, ChannelTally>()
  for (const [, client] of clients) tally(tallies, client)

  const sorted = [...tallies.values()].sort((a, b) => b.subscribers - a.subscribers || a.name.localeCompare(b.name))
  const channels = sorted.slice(0, CHANNEL_LIST_MAX).map((entry): ChannelSummary => {
    const last = lastEvents.get(entry.name)
    return {
      name: entry.name,
      subscribers: entry.subscribers,
      presence: entry.presence,
      targets: [...entry.targets.values()].sort(byTarget),
      createdAt: iso(entry.createdAt),
      lastEventAt: last === undefined ? null : iso(last),
    }
  })
  return { channels, truncated: sorted.length > CHANNEL_LIST_MAX, names: new Set(tallies.keys()) }
}

/** One connection as the inspector lists it. */
export function summariseConnection(id: string, client: ConnectedClient): ConnectionSummary {
  const sub = client.claims?.sub
  const role = client.claims?.role
  return {
    id,
    userId: typeof sub === "string" && sub !== "" ? sub : null,
    role: typeof role === "string" && role !== "" ? role : null,
    connectedAt: iso(client.connectedAt),
    lastMessageAt: client.lastMessageAt === null ? null : iso(client.lastMessageAt),
    channels: [...client.subscriptions.keys()],
    client: client.client,
    userAgent: client.userAgent,
  }
}
