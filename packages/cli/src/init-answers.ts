/**
 * The checks on what init is told, typed at a prompt or given as a flag, before any of it is
 * written. Manual test #37: a pasted email with carriage returns in it went into `.env` as it was,
 * and the server, reading each piece as a line, refused to start and logged the admin password.
 */
import { hasControlCharacter } from "./env-value.js"
import { p } from "./ui/clack.js"
import type { ClackTextOptions } from "./ui/clack-api.js"
import { ensureNotCancelled } from "./ui/prompts.js"

export const CONTROL_CHARACTER_PROBLEM =
  "That has a line break or another control character in it, from a paste perhaps. Type it on one line."

/** Why `value` cannot be an answer at all, or undefined when it can. */
export function answerProblem(value: string): string | undefined {
  return hasControlCharacter(value) ? CONTROL_CHARACTER_PROBLEM : undefined
}

/** One address: something, one `@`, something, with no whitespace or control characters. */
const ONE_ADDRESS = /^[^\s@]+@[^\s@]+$/

/** Why `value` is not one email address, or undefined when it is. Never repeats the value. */
export function adminEmailProblem(value: string): string | undefined {
  const email = value.trim()
  if (email === "") return "Email is required."
  if (hasControlCharacter(email)) return CONTROL_CHARACTER_PROBLEM
  return ONE_ADDRESS.test(email) ? undefined : "Enter one email address, like you@example.com."
}

/** A text prompt whose answer is refused while it holds a control character, then by `validate`. */
export async function askText(options: ClackTextOptions): Promise<string> {
  const { validate } = options
  const answer = await p.text({ ...options, validate: (value) => answerProblem(value) ?? validate?.(value) })
  return ensureNotCancelled(answer)
}
