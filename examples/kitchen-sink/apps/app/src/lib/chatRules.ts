import type { SupatypeError } from "@supatype/client"

/**
 * What the lobby checks before it sends a message, and what it says when a send is refused anyway.
 *
 * The schema states three rules on `ChatMessage.body`, and each one is checked here first so the
 * sender hears about a mistake without a round trip. The database still enforces all three: these
 * checks are a courtesy to the person typing, not the rule. A caller that skips this app (`psql`,
 * a script, another client) meets the same refusals, which is why `explainRefusal` exists.
 */

/** `Gte<Length<"body">, Literal<2>>`, the model constraint. */
export const CHAT_BODY_MIN = 2
/** `MaxLength<string, 500>`, the field bound. */
export const CHAT_BODY_MAX = 500

/**
 * The validator's rule, restated: six or more letters, none of them lower case.
 *
 * Kept in step with `hooks/validate-chat-body/index.ts` by hand. If the two drift, the server's
 * answer still wins, and arrives through `explainRefusal` with the validator's own words.
 */
function isShouting(body: string): boolean {
  const letters = body.replace(/[^\p{L}]/gu, "")
  return letters.length >= 6 && letters === letters.toUpperCase()
}

/**
 * Why `body` would be refused, in words for the sender, or null when it would not.
 *
 * Length is counted in characters, as Postgres's `length()` counts them, not in UTF-16 units, so an
 * emoji is one character here as it is in the `CHECK`.
 */
export function checkChatBody(body: string): string | null {
  const length = [...body].length
  if (length < CHAT_BODY_MIN) return `A message needs at least ${CHAT_BODY_MIN} characters.`
  if (length > CHAT_BODY_MAX) return `A message can be at most ${CHAT_BODY_MAX} characters (this one is ${length}).`
  if (isShouting(body)) return "That reads as shouting. Try it in lower case."
  return null
}

/**
 * A refused send, said in words for the sender rather than the database's.
 *
 * Matches on the error code, never on the constraint's name: names are the schema's business and
 * change with it, while `23514` means a `CHECK` refused the row whatever it is called. The raw
 * error goes to the console, where a developer looks for it.
 */
export function explainRefusal(error: SupatypeError): string {
  console.error(`[lobby] send refused (code ${error.code ?? "none"}, status ${error.status ?? "none"}): ${error.message}`, error)
  // A validator names the field and writes its message for the sender, so it is shown as written.
  if (error.field !== undefined) return error.message
  if (error.code === "23514") {
    return `A message needs between ${CHAT_BODY_MIN} and ${CHAT_BODY_MAX} characters.`
  }
  if (error.code === "42501") return "You are not allowed to post here. Try signing out and in again."
  // No HTTP status means no response arrived at all.
  if (error.status === undefined) return "Could not send: check your connection and try again."
  return "Could not send your message. Try again in a moment."
}
