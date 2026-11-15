/**
 * The machine-readable half of every refusal or withdrawal the server sends (P21).
 *
 * The sentence is for a person and may be reworded; the code is a contract. A client acts on the
 * code and shows the sentence. The set is closed: adding a member is a protocol change that clients
 * must learn about, and a client that meets a code it does not know reads it as `refused`.
 *
 * - `join_denied`: a declared channel's join rule said no (or declares none).
 * - `not_declared`: the join said private and no declaration matches the name.
 * - `does_not_fit`: a declaration matches the name's prefix but its parameters do not fit.
 * - `unavailable`: the database could not be asked; retrying may succeed.
 * - `shared_instance`: private channels are not available on a shared instance.
 * - `withdrawn`: a channel the socket held was taken back by a re-check.
 * - `send_denied`: a broadcast was refused; the channel itself is unaffected.
 * - `track_denied`: a presence track was refused; the channel itself is unaffected.
 * - `payload_refused`: the send rule's event or payload checks refused a broadcast.
 * - `refused`: any other refusal (a bad filter, a missing table, no token); the sentence says which.
 */
export const REFUSAL_CODES = [
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

export type RefusalCode = (typeof REFUSAL_CODES)[number]

/** One refusal: the fixed code and the sentence that goes with it. */
export interface Refusal {
  code: RefusalCode
  message: string
}

export const refusal = (code: RefusalCode, message: string): Refusal => ({ code, message })
