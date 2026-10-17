import type { Guard } from "@supatype/shared"

/** The start of a value as text, for a failure message. */
function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

/**
 * `value` narrowed by `guard`, or a thrown error showing what arrived instead.
 *
 * For a test reading back something the code under test produced (a file it wrote, a line it
 * printed, an argument a mock recorded). A cast there let a wrong shape through, and the assertion
 * after it then compared `undefined` and failed somewhere that did not say why.
 */
export function expectShape<T>(value: unknown, guard: Guard<T>): T {
  if (!guard(value)) throw new Error(`Unexpected shape: ${preview(value)}`)
  return value
}

/** `text` parsed as JSON and narrowed by `guard`. */
export function parseJsonAs<T>(text: string, guard: Guard<T>): T {
  return expectShape(JSON.parse(text), guard)
}
