import type { Queryable } from "./channel-db.js"
import { sqlState } from "./drop-log.js"
import { isBoolean, isShape, isString, nullable } from "./json.js"

/**
 * What a project says about channels, and what a caller may do on one: the pure half of private
 * channels. Nothing here touches a socket; `channel-guard.ts` asks the database and applies these.
 */

/** `open`: a channel nothing declares behaves as it always did. `declared`: it may be joined, never sent on. */
export type ChannelMode = "open" | "declared"

/** The most restrictive of the modes given: the environment can only tighten what the database says. */
export function tightest(...modes: Array<ChannelMode | null | undefined>): ChannelMode {
  return modes.includes("declared") ? "declared" : "open"
}

/**
 * One row of `_supatype.realtime_channel_access(topic)`.
 *
 * A verdict is true (the rule admits), false (the rule denies) or null (the declaration has no rule
 * for that operation, so only the service role may do it). Null is never a grant.
 */
export interface AccessRow {
  channel: string
  /** The declared pattern, `lot:{id}`, for naming it in a refusal. */
  pattern: string
  fits: boolean
  /** Why a parameter does not fit (`id must be a UUID`), when `fits` is false. */
  param_error: string | null
  can_join: boolean | null
  can_send: boolean | null
  can_track: boolean | null
}

const isAccessRow = isShape({
  channel: isString,
  pattern: isString,
  fits: isBoolean,
  param_error: nullable(isString),
  can_join: nullable(isBoolean),
  can_send: nullable(isBoolean),
  can_track: nullable(isBoolean),
})

/**
 * What a caller may do on one channel, decided once at join and read on every later frame.
 *
 * `send` and `track` are the refusal to give when the caller attempts them, or null when allowed.
 * Holding the sentence rather than a boolean keeps the refusal beside the decision that made it, so
 * a frame costs a property read and says exactly why.
 */
export interface ChannelGrant {
  /** The declaration the topic matched, or null for an undeclared channel and for the service role. */
  declaration: string | null
  send: string | null
  track: string | null
  /** Whether the join said it was private: if the declaration is later removed, the channel goes. */
  openedAsPrivate: boolean
  checkedAt: number
}

/** The database answered something that cannot be acted on safely. Always read as a refusal. */
export class AccessAnswerError extends Error {}

const INSUFFICIENT_PRIVILEGE = "42501"

/**
 * What a rule that the database refused to run is read as: a denial of everything.
 *
 * A rule reading a table the caller has no privilege on raises `insufficient_privilege` instead of
 * returning false, which is what the anon role meets on any rule that reads a table anon cannot see.
 * That is the database saying no, so it is read as no (and as a denial, not as "the database did
 * not answer", which would tell the client to retry something that will never succeed).
 */
export const DENIED_BY_DATABASE: AccessRow = {
  channel: "this channel's declaration",
  pattern: "",
  fits: true,
  param_error: null,
  can_join: false,
  can_send: false,
  can_track: false,
}

/**
 * Ask the database what the caller (the session `q` runs as) may do on `topic`.
 *
 * The topic reaches SQL only as a bound parameter. Zero rows mean no declaration matches. More than
 * one cannot happen, since the engine refuses overlapping patterns, so it is treated as a broken
 * answer and refused rather than resolved by taking the first: the first might be the permissive one.
 */
export async function fetchAccess(q: Queryable, topic: string): Promise<AccessRow | null> {
  try {
    return await readAccess(q, topic)
  } catch (err) {
    if (sqlState(err) === INSUFFICIENT_PRIVILEGE) return DENIED_BY_DATABASE
    throw err
  }
}

async function readAccess(q: Queryable, topic: string): Promise<AccessRow | null> {
  const result = await q.query(
    "SELECT channel, pattern, fits, param_error, can_join, can_send, can_track FROM _supatype.realtime_channel_access($1)",
    [topic],
  )
  if (result.rows.length === 0) return null
  const [row, ...rest] = result.rows
  if (rest.length > 0 || !isAccessRow(row)) throw new AccessAnswerError(`unusable answer for ${topic}`)
  return row
}

// ─── What the caller is told (plan section 7) ───────────────────────────────

/**
 * The longest channel name accepted. Checked before any database call: a name is client-chosen and
 * is bound into a regex match in SQL, so an unbounded one is an unbounded cost on a join.
 */
export const MAX_TOPIC_LENGTH = 255

const unreachable = (topic: string): string =>
  `could not check access to ${topic} because the database did not answer; retry`

const denied = (op: "join" | "broadcast on" | "track presence on", rule: string, topic: string, channel: string): string =>
  `not allowed to ${op} ${topic}: the ${rule} rule of ${channel} denied it`

export const refusals = {
  unreachable,
  join: (topic: string, channel: string): string => denied("join", "join", topic, channel),
  send: (topic: string, channel: string): string => denied("broadcast on", "send", topic, channel),
  track: (topic: string, channel: string): string => denied("track presence on", "track", topic, channel),
  doesNotFit: (topic: string, row: AccessRow): string =>
    `${topic} does not fit ${row.pattern}${row.param_error === null ? "" : `: ${row.param_error}`}`,
  noRule: (op: "join" | "broadcast on" | "track presence on", topic: string, channel: string): string =>
    `${channel} declares no ${op === "broadcast on" ? "send" : op === "join" ? "join" : "track"} rule, so only the service role may ${op} ${topic}`,
  tooLong: (length: number): string => `channel name is too long: ${length} characters, the limit is ${MAX_TOPIC_LENGTH}`,
  undeclared: (topic: string): string =>
    `${topic} matches no declared channel, and this project refuses broadcast and presence on ` +
    'undeclared channels (realtime.channels is "declared")',
  privateButUndeclared: (topic: string): string =>
    `${topic} was opened as private, but no Channel declaration matches it`,
  withdrawn: (topic: string, channel: string): string =>
    `access to ${topic} was withdrawn: the join rule of ${channel} no longer admits this user`,
  withdrawnUndeclared: (topic: string): string =>
    `access to ${topic} was withdrawn: it was opened as private, and no Channel declaration matches it any more`,
  sharedInstance: "private channels are not available on a shared realtime instance",
  payload: (event: string, topic: string, channel: string): string =>
    `not allowed to broadcast ${event} on ${topic}: the send rule of ${channel} refused the payload`,
} as const

// ─── Decisions ─────────────────────────────────────────────────────────────

/** Why a join is refused, or the grant it is admitted with. */
export type JoinDecision = { admitted: true; grant: ChannelGrant } | { admitted: false; message: string }

/** The refusal for one operation: none when admitted, the denial when a rule said no, the no-rule sentence for null. */
function opRefusal(verdict: boolean | null, denial: string, noRule: string): string | null {
  if (verdict === true) return null
  return verdict === false ? denial : noRule
}

function joinRefusal(topic: string, row: AccessRow): string {
  return row.can_join === null ? refusals.noRule("join", topic, row.channel) : refusals.join(topic, row.channel)
}

/** Every right, for the service role: it bypasses channel rules as it bypasses RLS. */
export function serviceGrant(now: number): ChannelGrant {
  return { declaration: null, send: null, track: null, openedAsPrivate: false, checkedAt: now }
}

/**
 * The grant for a channel no declaration matches, in `mode`.
 *
 * Open: as before, anyone who joined may send and track. Declared: the join stands (a join that only
 * listens for table rows names a channel after its table, and the table's own rules guard those),
 * but nobody can send or track, so there is nothing to hear and no presence to leak.
 */
export function undeclaredGrant(topic: string, mode: ChannelMode, now: number): ChannelGrant {
  const refusal = mode === "declared" ? refusals.undeclared(topic) : null
  return { declaration: null, send: refusal, track: refusal, openedAsPrivate: false, checkedAt: now }
}

/**
 * Decide a join from the database's answer: the table in plan 4.1.
 *
 * `row` is null when no declaration matches. A row whose `fits` is false is a topic with the right
 * prefix and a parameter of the wrong shape, which is refused rather than treated as undeclared:
 * otherwise `lot:abc` would be an undeclared channel, open in `open` mode, one typo away from a
 * private one. A null verdict from a rule (NULL in SQL) is a denial, never a grant.
 */
export function decideJoin(
  topic: string,
  row: AccessRow | null,
  options: { mode: ChannelMode; isPrivate: boolean; now: number },
): JoinDecision {
  const { mode, isPrivate, now } = options
  if (row === null) {
    if (isPrivate) return { admitted: false, message: refusals.privateButUndeclared(topic) }
    return { admitted: true, grant: undeclaredGrant(topic, mode, now) }
  }
  if (!row.fits) return { admitted: false, message: refusals.doesNotFit(topic, row) }
  if (row.can_join !== true) return { admitted: false, message: joinRefusal(topic, row) }
  return {
    admitted: true,
    grant: {
      declaration: row.channel,
      send: opRefusal(row.can_send, refusals.send(topic, row.channel), refusals.noRule("broadcast on", topic, row.channel)),
      track: opRefusal(row.can_track, refusals.track(topic, row.channel), refusals.noRule("track presence on", topic, row.channel)),
      openedAsPrivate: isPrivate,
      checkedAt: now,
    },
  }
}

/** The sentence for a held channel that a re-check no longer admits, in the terms of what changed. */
export function withdrawalMessage(topic: string, row: AccessRow | null): string {
  if (row === null) return refusals.withdrawnUndeclared(topic)
  return row.fits ? refusals.withdrawn(topic, row.channel) : refusals.doesNotFit(topic, row)
}
