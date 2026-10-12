import type { JwtClaims } from "../auth.js"
import { redactRestricted, type RedactedColumns } from "../field-mask.js"
import type { DeliveryVerdict } from "../rls.js"
import type { WalChange } from "../types.js"
import type { BroadcastSeen, ChangeRecord, DeliveryRef, PresenceSeen, TapItem, TapRenderer } from "./tap.js"

/**
 * How the inspector shows a change, per payload view.
 *
 * The rule: never more than the subscriber received, never more than the viewer could already
 * read, never the WAL row as decoded.
 *
 * - `delivered`: each delivery as that subscriber received it, masked columns listed as redacted.
 * - `redacted`: each delivery with every read-restricted column of the table nulled and listed,
 *   whatever the subscriber's verdict. An unknown mask catalog redacts every column.
 * - `viewer`: no per-delivery payloads; the change judged as the Studio viewer, through the same
 *   rules a subscriber goes through.
 * - `none`: metadata only.
 */

export type PayloadView = "delivered" | "redacted" | "viewer" | "none"

export const PAYLOAD_VIEWS: readonly PayloadView[] = ["delivered", "redacted", "viewer", "none"]

/** A payload larger than this is left out, not cut, and flagged `truncated`. */
export const PAYLOAD_MAX_BYTES = 16 * 1024

interface Sides {
  old: Record<string, unknown> | null
  new: Record<string, unknown> | null
}

/** What the renderer needs of the access rules: the restricted columns, and a judgement as a viewer. */
export interface ViewRules {
  maskedColumns(schema: string, table: string): Promise<Set<string>>
  inspectAs(claims: JwtClaims | null, change: WalChange): Promise<DeliveryVerdict>
}

export interface ViewContext {
  view: PayloadView
  /** The Studio viewer's verified claims; set exactly when `view` is `viewer`. */
  viewer: JwtClaims | null
  /** The session's channel filter, which also narrows a change's deliveries to that channel. */
  channel: string | undefined
  rules: ViewRules
}

function bytes(frame: string): number {
  return Buffer.byteLength(frame, "utf8")
}

/** The payload and its redacted columns, or `truncated` instead of a payload over the limit. */
function shown(sides: Sides, redacted: RedactedColumns): Record<string, unknown> {
  if (bytes(JSON.stringify(sides)) > PAYLOAD_MAX_BYTES) return { redacted, truncated: true }
  return { payload: sides, redacted }
}

function deliveryView(d: DeliveryRef, ctx: ViewContext, restricted: Set<string> | null): Record<string, unknown> {
  const base = { connectionId: d.connectionId, channel: d.channel, bytes: bytes(d.frame) }
  const sides = { old: d.visible.oldRecord, new: d.visible.newRecord }
  if (ctx.view === "delivered") return { ...base, ...shown(sides, d.redacted) }
  if (ctx.view === "redacted" && restricted) {
    const r = redactRestricted(sides, restricted)
    return { ...base, ...shown({ old: r.oldRecord, new: r.newRecord }, r.redacted) }
  }
  return base
}

async function viewerView(record: ChangeRecord, ctx: ViewContext): Promise<Record<string, unknown>> {
  const verdict = await ctx.rules.inspectAs(ctx.viewer, record.change)
  if ("refused" in verdict) return { visible: false }
  return { visible: true, ...shown({ old: verdict.send.oldRecord, new: verdict.send.newRecord }, verdict.redacted) }
}

async function renderChange(item: { seq: number; at: string; record: ChangeRecord }, ctx: ViewContext): Promise<unknown> {
  const { record } = item
  const { change } = record
  const onChannel = <T extends { channel: string }>(rows: readonly T[]): T[] =>
    ctx.channel === undefined ? [...rows] : rows.filter((row) => row.channel === ctx.channel)
  const restricted = ctx.view === "redacted" ? await ctx.rules.maskedColumns(change.schema, change.table) : null
  return {
    seq: item.seq,
    at: item.at,
    commitTimestamp: change.commitTimestamp,
    schema: change.schema,
    table: change.table,
    event: change.event,
    deliveries: onChannel(record.deliveries).map((d) => deliveryView(d, ctx, restricted)),
    withheld: onChannel(record.withheld).map((w) => ({
      connectionId: w.connectionId,
      channel: w.channel,
      severity: w.refusal.severity,
      reason: w.refusal.reason,
    })),
    notMatched: record.notMatched,
    ...(ctx.view === "viewer" && { viewer: await viewerView(record, ctx) }),
  }
}

function renderBroadcast(item: { seq: number; at: string; broadcast: BroadcastSeen }, ctx: ViewContext): unknown {
  const b = item.broadcast
  const payloadBytes = bytes(JSON.stringify(b.payload))
  const payload =
    ctx.view === "none" ? {} : payloadBytes > PAYLOAD_MAX_BYTES ? { truncated: true } : { payload: b.payload }
  return {
    seq: item.seq,
    at: item.at,
    channel: b.channel,
    event: b.event,
    origin: b.origin,
    senderConnectionId: b.senderConnectionId,
    recipients: b.recipients,
    bytes: b.frame === null ? payloadBytes : bytes(b.frame),
    ...payload,
  }
}

function renderPresence(item: { seq: number; at: string; presence: PresenceSeen }): unknown {
  const p = item.presence
  return { seq: item.seq, at: item.at, channel: p.channel, kind: p.kind, userId: p.userId, recipients: p.recipients }
}

/** The renderer for one session's view. */
export function viewRenderer(ctx: ViewContext): TapRenderer {
  return async (item: TapItem) => {
    switch (item.kind) {
      case "change":
        return { event: "change", data: await renderChange(item, ctx) }
      case "broadcast":
        return { event: "broadcast", data: renderBroadcast(item, ctx) }
      case "presence":
        return { event: "presence", data: renderPresence(item) }
    }
  }
}
