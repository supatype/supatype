/**
 * The Realtime Inspector's contract, as both control planes serve it (self-host's at
 * `/platform/v1/projects/:ref/realtime`, Cloud's at `/projects/:ref/realtime`), relayed from
 * realtime's own admin API. Phase-08 Appendix A, sections 3.2 and 3.4.
 */

export type ChangeEvent = "INSERT" | "UPDATE" | "DELETE"

export interface ChannelTarget {
  schema: string
  table: string
  event: ChangeEvent | "*"
  /** Some subscriber on this target filters by column. The filter values are never sent. */
  filtered: boolean
  subscribers: number
}

export interface ChannelSummary {
  name: string
  subscribers: number
  presence: number
  targets: ChannelTarget[]
  createdAt: string
  lastEventAt: string | null
}

export interface ChannelsData {
  service: { ready: boolean; reason: string | null }
  channels: ChannelSummary[]
  truncated?: boolean
}

export interface ConnectionSummary {
  id: string
  userId: string | null
  role: string | null
  connectedAt: string
  lastMessageAt: string | null
  channels: string[]
  client: { name: string; version: string | null } | null
  userAgent: string | null
}

export interface ConnectionsData {
  total: number
  /** The project's connection limit, or null when there is none (self-host by default). */
  limit: number | null
  connections: ConnectionSummary[]
  next: string | null
  /** The Cloud plan, or null on self-host. */
  tier: string | null
}

export type PayloadView = "delivered" | "redacted" | "viewer" | "none"

export interface Sides {
  old: Record<string, unknown> | null
  new: Record<string, unknown> | null
}

export interface RedactedColumns {
  old: string[]
  new: string[]
}

export interface StreamDelivery {
  connectionId: string
  channel: string
  bytes: number
  payload?: Sides
  redacted?: RedactedColumns
  truncated?: true
}

export interface StreamWithheld {
  connectionId: string
  channel: string
  severity: "denied" | "failed"
  reason: string
}

export interface StreamChange {
  seq: number
  at: string
  commitTimestamp: string
  schema: string
  table: string
  event: ChangeEvent
  deliveries: StreamDelivery[]
  withheld: StreamWithheld[]
  notMatched: number
  viewer?: { visible: boolean; payload?: Sides; redacted?: RedactedColumns; truncated?: true }
}

export interface StreamBroadcast {
  seq: number
  at: string
  channel: string
  event: string
  origin: "client" | "studio"
  senderConnectionId: string | null
  recipients: number
  bytes: number
  payload?: Record<string, unknown>
  truncated?: true
}

export interface StreamPresence {
  seq: number
  at: string
  channel: string
  kind: "join" | "leave"
  userId: string
  recipients: number
}

export interface StreamReady {
  view: PayloadView
  rate: number
  filters: Record<string, string>
}

/** One row of the stream as the Stream tab lists it. */
export type StreamRow =
  | { kind: "change"; change: StreamChange }
  | { kind: "broadcast"; broadcast: StreamBroadcast }
  | { kind: "presence"; presence: StreamPresence }
  | { kind: "sampled"; skipped: number; since: string; key: string }

export interface BroadcastRequest {
  channel: string
  event: string
  payload: Record<string, unknown>
}
