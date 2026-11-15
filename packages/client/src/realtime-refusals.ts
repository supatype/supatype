import { RealtimeChannelError, type RealtimeChannelErrorReason } from "./errors.js"

/**
 * What the client says when a `private: true` join meets a server that would ignore the flag and
 * admit an open channel. The join is never sent.
 */
export const UNSUPPORTED_SERVER_MESSAGE = "this realtime server does not enforce private channels; upgrade it"

/** The feature a server announces on its first frame when it enforces private channels. */
export const PRIVATE_CHANNELS_FEATURE = "private_channels"

/**
 * The sentences the realtime server refuses with (packages/realtime `refusals`), each as the
 * reason it means. The wire carries the sentence and no code, so this is read from the sentence;
 * one the client does not know is `refused`, with the server's own words as the message.
 *
 * Order matters only where a sentence could match two: none do, but `withdrawn` is tested first as
 * it is the one a channel already held can receive.
 */
const REFUSAL_READINGS: ReadonlyArray<readonly [RegExp, RealtimeChannelErrorReason]> = [
  [/^access to .+ was withdrawn: /, "withdrawn"],
  [/^not allowed to join /, "join_denied"],
  [/ was opened as private, but no Channel declaration matches it$/, "not_declared"],
  [/ does not fit /, "does_not_fit"],
  [/^could not check access to .+ because the database did not answer; retry$/, "unavailable"],
  [/^private channels are not available on a shared realtime instance$/, "shared_instance"],
]

/** Why the server refused or withdrew a channel, read from its message. */
export function refusalReason(message: string): RealtimeChannelErrorReason {
  for (const [pattern, reason] of REFUSAL_READINGS) {
    if (pattern.test(message)) return reason
  }
  return "refused"
}

/** The typed error for a channel-scoped refusal frame. */
export function channelRefusal(channel: string, message: string): RealtimeChannelError {
  return new RealtimeChannelError(message, channel, refusalReason(message))
}

/** The error a private join gets from a server that does not announce `private_channels`. */
export function unsupportedServer(channel: string): RealtimeChannelError {
  return new RealtimeChannelError(UNSUPPORTED_SERVER_MESSAGE, channel, "unsupported_server")
}
