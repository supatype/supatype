import { RealtimeChannelError, type RealtimeChannelErrorReason } from "./errors.js"

/**
 * What the client says when a `private: true` join meets a server that would ignore the flag and
 * admit an open channel. The join is never sent.
 */
export const UNSUPPORTED_SERVER_MESSAGE = "this realtime server does not enforce private channels; upgrade it"

/** The feature a server announces on its first frame when it enforces private channels. */
export const PRIVATE_CHANNELS_FEATURE = "private_channels"

/**
 * The refusals of something sent on a channel that is itself fine: a broadcast, a presence track,
 * or a payload the channel's send rule rejects. They are not a failed join, so they never move the
 * channel's status; the app hears of them through `onRefused`.
 */
export type ChannelActionRefusalCode = "send_denied" | "track_denied" | "payload_refused"

/** What `onRefused` hands its callback: which channel, why (the server's fixed code), and in words. */
export interface ChannelActionRefusal {
  channel: string
  code: ChannelActionRefusalCode
  message: string
}

/** What a refusal frame turned out to be: a reason for the channel's error, or an action refusal. */
export type RefusalKind = Exclude<RealtimeChannelErrorReason, "unsupported_server"> | ChannelActionRefusalCode

/**
 * Every code the server sends (packages/realtime `refusal-codes.ts`). `unsupported_server` is the
 * client's own and is not on the wire.
 */
const KNOWN_KINDS: ReadonlyMap<string, RefusalKind> = new Map<string, RefusalKind>(
  (
    [
      "join_denied",
      "not_declared",
      "does_not_fit",
      "unavailable",
      "shared_instance",
      "withdrawn",
      "send_denied",
      "track_denied",
      "payload_refused",
      "refused",
    ] as const
  ).map((code) => [code, code]),
)

/** Whether `kind` is a refusal of an action on a healthy channel rather than of the channel. */
export function isActionRefusal(kind: RefusalKind): kind is ChannelActionRefusalCode {
  return kind === "send_denied" || kind === "track_denied" || kind === "payload_refused"
}

/**
 * The sentences the realtime server refused with before it sent codes (packages/realtime
 * `refusals`), each as the code it now carries. A fallback for an older server only: a frame with a
 * `code` is never read by its sentence, which may be reworded. Dropped once no supported server
 * predates codes.
 */
const LEGACY_SENTENCES: ReadonlyArray<readonly [RegExp, RefusalKind]> = [
  [/^access to .+ was withdrawn: /, "withdrawn"],
  [/^not allowed to join /, "join_denied"],
  [/ was opened as private, but no Channel declaration matches it$/, "not_declared"],
  [/ does not fit /, "does_not_fit"],
  [/^could not check access to .+ because the database did not answer; retry$/, "unavailable"],
  [/^private channels are not available on a shared realtime instance$/, "shared_instance"],
  [/^not allowed to broadcast .+: the send rule of .+ refused the payload$/, "payload_refused"],
  [/^not allowed to broadcast on /, "send_denied"],
  [/ declares no send rule, so only the service role may /, "send_denied"],
  [/^not allowed to track presence on /, "track_denied"],
  [/ declares no track rule, so only the service role may /, "track_denied"],
]

function readSentence(message: string): RefusalKind {
  for (const [pattern, kind] of LEGACY_SENTENCES) {
    if (pattern.test(message)) return kind
  }
  return "refused"
}

/**
 * What a channel-scoped refusal frame is. The server's `code` decides; a code this client does not
 * know is `refused` (a newer server, with the server's own words as the message). Only a frame with
 * no code at all, from an older server, is read from its sentence.
 */
export function classifyRefusal(code: string | undefined, message: string): RefusalKind {
  if (code === undefined) return readSentence(message)
  return KNOWN_KINDS.get(code) ?? "refused"
}

/** The typed error for a channel-scoped refusal frame that fails or ends a channel's join. */
export function channelRefusal(channel: string, message: string, kind: RefusalKind): RealtimeChannelError {
  return new RealtimeChannelError(message, channel, isActionRefusal(kind) ? "refused" : kind)
}

/** The error a private join gets from a server that does not announce `private_channels`. */
export function unsupportedServer(channel: string): RealtimeChannelError {
  return new RealtimeChannelError(UNSUPPORTED_SERVER_MESSAGE, channel, "unsupported_server")
}
