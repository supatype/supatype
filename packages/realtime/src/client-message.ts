import { isJsonObject, isOneOf, isRecordOf, isShape, isString, optional, type Guard } from "./json.js"
import type { ClientMessage } from "./types.js"

/**
 * A socket frame from a client, checked against the messages the server reads. Anything else (not
 * JSON, an unknown `type`, a subscribe with no channel, a payload that is not an object) is refused
 * as one, so no handler sees a field missing or of the wrong type.
 */

const isSubscribe = isShape({
  type: isOneOf(["subscribe"] as const),
  channel: isString,
  event: optional(isOneOf(["INSERT", "UPDATE", "DELETE", "*"] as const)),
  table: optional(isString),
  schema: optional(isString),
  filter: optional(isRecordOf(isString)),
  ref: optional(isString),
})

const isUnsubscribe = isShape({ type: isOneOf(["unsubscribe"] as const), channel: isString })

const isPresenceTrack = isShape({
  type: isOneOf(["presence_track"] as const),
  channel: isString,
  payload: isJsonObject,
})

const isPresenceUntrack = isShape({ type: isOneOf(["presence_untrack"] as const), channel: isString })

const isBroadcast = isShape({
  type: isOneOf(["broadcast"] as const),
  channel: isString,
  event: isString,
  payload: isJsonObject,
})

const isAuth = isShape({ type: isOneOf(["auth"] as const), token: isString })

const CLIENT_MESSAGES: ReadonlyArray<Guard<ClientMessage>> = [
  isSubscribe,
  isUnsubscribe,
  isPresenceTrack,
  isPresenceUntrack,
  isBroadcast,
  isAuth,
]

/** The message a frame carries, or null when it is not one the server reads. */
export function parseClientMessage(frame: string): ClientMessage | null {
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    return null
  }
  for (const isMessage of CLIENT_MESSAGES) {
    if (isMessage(value)) return value
  }
  return null
}
