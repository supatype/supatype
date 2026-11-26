import { isArrayOf, isBoolean, isJsonObject, isNumber, isShape, isString, isOneOf, optional, type Guard } from "./json.js"

/**
 * The content rules of a channel's `send` rule (plan 13.2): which event name and which payload
 * shapes a broadcast may carry. They need no table, so the server judges them itself on every
 * message, with no database call, from what `_supatype.realtime_channel_send_checks()` returned.
 *
 * The engine renders these nodes as TRUE in SQL (the database cannot see an event or a payload), so
 * what the database admitted says nothing about them: an author's `Event<"bid">` is enforced here
 * or nowhere.
 */

/** A check on one field of the payload. A type check also requires the field to be present. */
export type PayloadCheck =
  | { kind: "string"; maxLength?: number | undefined }
  | { kind: "number"; min?: number | undefined; max?: number | undefined }
  | { kind: "boolean" }
  | { kind: "required" }

export type SendRule =
  | { type: "event"; name: string }
  | { type: "payload"; field: string; check: PayloadCheck }
  | { type: "all"; rules: SendRule[] }
  | { type: "any"; rules: SendRule[] }

/** What the server holds for one channel: no rule, a rule, or one it could not read. */
export type ChannelSendChecks = { state: "none" } | { state: "rule"; rule: SendRule } | { state: "unreadable" }

const isPayloadCheck: Guard<PayloadCheck> = (value): value is PayloadCheck =>
  isShape({ kind: isOneOf(["string"] as const), maxLength: optional(isNumber) })(value) ||
  isShape({ kind: isOneOf(["number"] as const), min: optional(isNumber), max: optional(isNumber) })(value) ||
  isShape({ kind: isOneOf(["boolean", "required"] as const) })(value)

const isLeaf = (value: unknown): value is SendRule =>
  isShape({ type: isOneOf(["event"] as const), name: isString })(value) ||
  isShape({ type: isOneOf(["payload"] as const), field: isString, check: isPayloadCheck })(value)

const isGroup = (value: unknown): value is SendRule =>
  isShape({ type: isOneOf(["all", "any"] as const), rules: isArrayOf(isSendRule) })(value)

function isSendRule(value: unknown): value is SendRule {
  return isLeaf(value) || isGroup(value)
}

/**
 * The checks the engine returned for a channel. A bare array is read as `all`. Anything else that is
 * not a rule this server understands is `unreadable`, never `none`: a rule the author wrote and the
 * server cannot read must stop broadcasts, not wave them through.
 */
export function parseSendChecks(raw: unknown): ChannelSendChecks {
  if (raw === null || raw === undefined) return { state: "none" }
  if (Array.isArray(raw)) {
    return raw.every(isSendRule) ? { state: "rule", rule: { type: "all", rules: raw } } : { state: "unreadable" }
  }
  return isSendRule(raw) ? { state: "rule", rule: raw } : { state: "unreadable" }
}

function payloadField(payload: Record<string, unknown>, field: string): unknown {
  // Own properties only: a field called `constructor` or `__proto__` is not on the payload because
  // every object inherits one.
  return Object.hasOwn(payload, field) ? payload[field] : undefined
}

function passesCheck(value: unknown, check: PayloadCheck): boolean {
  switch (check.kind) {
    case "required":
      return value !== undefined && value !== null
    case "boolean":
      return isBoolean(value)
    case "string":
      return isString(value) && (check.maxLength === undefined || value.length <= check.maxLength)
    case "number":
      return (
        isNumber(value) &&
        Number.isFinite(value) &&
        (check.min === undefined || value >= check.min) &&
        (check.max === undefined || value <= check.max)
      )
  }
}

function holds(rule: SendRule, event: string, payload: Record<string, unknown>): boolean {
  switch (rule.type) {
    case "event":
      return event === rule.name
    case "payload":
      return passesCheck(payloadField(payload, rule.field), rule.check)
    case "all":
      return rule.rules.every((inner) => holds(inner, event, payload))
    case "any":
      return rule.rules.some((inner) => holds(inner, event, payload))
  }
}

/** True when a broadcast of `event` carrying `payload` passes the channel's content checks. */
export function sendChecksAdmit(checks: ChannelSendChecks, event: string, payload: unknown): boolean {
  if (checks.state === "none") return true
  if (checks.state === "unreadable" || !isJsonObject(payload)) return false
  return holds(checks.rule, event, payload)
}
