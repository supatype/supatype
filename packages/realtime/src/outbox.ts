import { isJsonObject, isString } from "./json.js"
import type { WalChange } from "./types.js"

/**
 * Broadcasts sent from the database (plan 13.3).
 *
 * `_supatype.realtime_send` inserts a row into `_supatype.realtime_outbox` and deletes it in the same
 * transaction, so the row reaches the replication slot and never accumulates. The server turns the
 * insert into a broadcast. `anon` holds nothing on the table. `authenticated` may insert, but row
 * level security admits a row only as the caller's own `sender` and only when
 * `_supatype.realtime_send_refusal` (the caller's send rule, event and payload checks included)
 * finds no reason to refuse it, so a direct insert is judged exactly as a `realtime_send` call is.
 *
 * The send rule's checks are therefore not applied again here: the database already applied them as
 * the caller (`realtime_send` is SECURITY INVOKER), and the stream carries no claims to judge them
 * against. Delivery reaches only members of the topic, who were each admitted by its join rule.
 */

export const OUTBOX_SCHEMA = "_supatype"
export const OUTBOX_TABLE = "realtime_outbox"

/** A broadcast a function in the database asked for. */
export interface OutboxBroadcast {
  channel: string
  event: string
  payload: Record<string, unknown>
}

/** True for any change to the outbox: the insert, and the delete that follows it in the same transaction. */
export function isOutboxChange(change: WalChange): boolean {
  return change.schema === OUTBOX_SCHEMA && change.table === OUTBOX_TABLE
}

/**
 * The payload as an object. `jsonb` normally arrives parsed; a slot that handed it over as text is
 * read, and anything that is not an object is not a payload.
 */
function payloadOf(value: unknown): Record<string, unknown> | null {
  if (isJsonObject(value)) return value
  if (!isString(value)) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The broadcast an outbox change asks for, or null when it asks for none: a delete, or a row that
 * is not a topic, an event and an object. A row like that is dropped, never repaired: guessing at
 * what a function meant to send is how a message reaches a channel it was not for.
 */
export function outboxBroadcast(change: WalChange): OutboxBroadcast | null {
  if (change.event !== "INSERT" || change.newRecord === null) return null
  const { topic, event, payload } = change.newRecord
  const body = payloadOf(payload)
  if (!isString(topic) || topic === "" || !isString(event) || event === "" || body === null) return null
  return { channel: topic, event, payload: body }
}
