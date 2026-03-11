/** Event types for database change notifications. */
export type ChangeEvent = "INSERT" | "UPDATE" | "DELETE"

/** A database change captured from logical replication. */
export interface WalChange {
  schema: string
  table: string
  event: ChangeEvent
  /** The new row data (null for DELETE). */
  newRecord: Record<string, unknown> | null
  /** The old row data (null for INSERT). */
  oldRecord: Record<string, unknown> | null
  commitTimestamp: string
}

// ─── Client → Server messages ────────────────────────────────────────────────

export interface SubscribeMessage {
  type: "subscribe"
  channel: string
  event?: ChangeEvent | "*" | undefined
  filter?: Record<string, string> | undefined
}

export interface UnsubscribeMessage {
  type: "unsubscribe"
  channel: string
}

export interface PresenceTrackMessage {
  type: "presence_track"
  channel: string
  payload: Record<string, unknown>
}

export interface PresenceUntrackMessage {
  type: "presence_untrack"
  channel: string
}

export interface BroadcastMessage {
  type: "broadcast"
  channel: string
  event: string
  payload: Record<string, unknown>
}

export interface AuthMessage {
  type: "auth"
  token: string
}

export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | PresenceTrackMessage
  | PresenceUntrackMessage
  | BroadcastMessage
  | AuthMessage

// ─── Server → Client messages ────────────────────────────────────────────────

export interface ChangeEventMessage {
  type: "change"
  channel: string
  event: ChangeEvent
  payload: {
    old: Record<string, unknown> | null
    new: Record<string, unknown> | null
  }
  timestamp: string
}

export interface PresenceEventMessage {
  type: "presence"
  channel: string
  joins: PresenceEntry[]
  leaves: PresenceEntry[]
}

export interface PresenceEntry {
  user_id: string
  [key: string]: unknown
}

export interface BroadcastEventMessage {
  type: "broadcast"
  channel: string
  event: string
  payload: Record<string, unknown>
}

export interface SystemMessage {
  type: "system"
  status: "ok" | "error"
  message: string
  ref?: string | undefined
}

export type ServerMessage =
  | ChangeEventMessage
  | PresenceEventMessage
  | BroadcastEventMessage
  | SystemMessage

// ─── Subscription tracking ───────────────────────────────────────────────────

export interface Subscription {
  channel: string
  /** Parsed as schema:table from the channel name. */
  schema: string
  table: string
  /** Event filter — "*" means all events. */
  event: ChangeEvent | "*"
  /** PostgREST-style column filters. */
  filter: Record<string, string>
}
