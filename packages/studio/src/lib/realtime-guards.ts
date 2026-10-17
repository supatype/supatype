import type {
  ChannelSummary,
  ChannelsData,
  ChannelTarget,
  ConnectionSummary,
  ConnectionsData,
  RedactedColumns,
  Sides,
  StreamBroadcast,
  StreamChange,
  StreamDelivery,
  StreamPresence,
  StreamReady,
  StreamWithheld,
} from "../views/realtime/types.js"
import {
  isArrayOf,
  isBoolean,
  isJsonObject,
  isNumber,
  isOneOf,
  isRecordOf,
  isShape,
  isString,
  nullable,
  optional,
  type Guard,
} from "./json.js"

/**
 * The Realtime Inspector's answers and stream events, checked as they arrive.
 *
 * Each guard follows what realtime's admin API writes (`packages/realtime/src/admin/views.ts`,
 * `stream.ts` and `channel-summary.ts`), so a stream event that matches the contract is shown and one
 * that does not is skipped, the same as an event that is not JSON.
 */

const isTrue = isOneOf([true] as const)
const isStringList = isArrayOf(isString)

const isSides: Guard<Sides> = isShape({ old: nullable(isJsonObject), new: nullable(isJsonObject) })

const isRedactedColumns: Guard<RedactedColumns> = isShape({ old: isStringList, new: isStringList })

const isDelivery: Guard<StreamDelivery> = isShape({
  connectionId: isString,
  channel: isString,
  bytes: isNumber,
  payload: optional(isSides),
  redacted: optional(isRedactedColumns),
  truncated: optional(isTrue),
})

const isWithheld: Guard<StreamWithheld> = isShape({
  connectionId: isString,
  channel: isString,
  severity: isOneOf(["denied", "failed"] as const),
  reason: isString,
})

const isViewerJudgement = isShape({
  visible: isBoolean,
  payload: optional(isSides),
  redacted: optional(isRedactedColumns),
  truncated: optional(isTrue),
})

export const isStreamChange: Guard<StreamChange> = isShape({
  seq: isNumber,
  at: isString,
  commitTimestamp: isString,
  schema: isString,
  table: isString,
  event: isOneOf(["INSERT", "UPDATE", "DELETE"] as const),
  deliveries: isArrayOf(isDelivery),
  withheld: isArrayOf(isWithheld),
  notMatched: isNumber,
  viewer: optional(isViewerJudgement),
})

export const isStreamBroadcast: Guard<StreamBroadcast> = isShape({
  seq: isNumber,
  at: isString,
  channel: isString,
  event: isString,
  origin: isOneOf(["client", "studio"] as const),
  senderConnectionId: nullable(isString),
  recipients: isNumber,
  bytes: isNumber,
  payload: optional(isJsonObject),
  truncated: optional(isTrue),
})

export const isStreamPresence: Guard<StreamPresence> = isShape({
  seq: isNumber,
  at: isString,
  channel: isString,
  kind: isOneOf(["join", "leave"] as const),
  userId: isString,
  recipients: isNumber,
})

export const isStreamReady: Guard<StreamReady> = isShape({
  view: isOneOf(["delivered", "redacted", "viewer", "none"] as const),
  rate: isNumber,
  filters: isRecordOf(isString),
})

/** How many events the server dropped to keep up, and since when. */
export const isStreamSampled = isShape({ skipped: isNumber, since: isString })

const isChannelTarget: Guard<ChannelTarget> = isShape({
  schema: isString,
  table: isString,
  event: isOneOf(["INSERT", "UPDATE", "DELETE", "*"] as const),
  filtered: isBoolean,
  subscribers: isNumber,
})

const isChannelSummary: Guard<ChannelSummary> = isShape({
  name: isString,
  subscribers: isNumber,
  presence: isNumber,
  targets: isArrayOf(isChannelTarget),
  createdAt: isString,
  lastEventAt: nullable(isString),
})

/** Realtime's channel listing (`summariseChannels`), with the service state the admin API adds. */
export const isChannelsData: Guard<ChannelsData> = isShape({
  service: isShape({ ready: isBoolean, reason: nullable(isString) }),
  channels: isArrayOf(isChannelSummary),
  truncated: optional(isBoolean),
})

const isConnectionSummary: Guard<ConnectionSummary> = isShape({
  id: isString,
  userId: nullable(isString),
  role: nullable(isString),
  connectedAt: isString,
  lastMessageAt: nullable(isString),
  channels: isStringList,
  client: nullable(isShape({ name: isString, version: nullable(isString) })),
  userAgent: nullable(isString),
})

/** A page of connections, with the limit realtime reports and the tier the control plane adds. */
export const isConnectionsData: Guard<ConnectionsData> = isShape({
  total: isNumber,
  limit: nullable(isNumber),
  connections: isArrayOf(isConnectionSummary),
  next: nullable(isString),
  tier: nullable(isString),
})

/** What a sent broadcast reports. */
export const isBroadcastSent = isShape({ recipients: isNumber })
