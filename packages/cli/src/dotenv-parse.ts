/**
 * The dotenv parser: one for every reader of a `.env` file, the CLI's and the functions worker's.
 *
 * No imports and no runtime APIs, so the same file runs under Node and Deno. The functions worker
 * carries an exact copy (packages/functions-worker/dotenv.ts), written from this one by
 * scripts/functions-worker-source.mjs and checked in CI, so a function's `ctx.env` reads a value
 * the way the CLI and compose do.
 */

/** `KEY` and the text after its `=` for an assignment line, or null for anything else. */
export function splitAssignment(line: string): { key: string; rest: string } | null {
  const trimmed = line.trim().replace(/^export\s+/, "")
  if (trimmed.startsWith("#")) return null
  const eq = trimmed.indexOf("=")
  if (eq <= 0) return null
  const key = trimmed.slice(0, eq).trim()
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? { key, rest: trimmed.slice(eq + 1) } : null
}

/** Index of the quote closing `value`'s opening one, skipping escaped quotes, or -1. */
function closingQuote(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === quote && value[i - 1] !== "\\") return i
  }
  return -1
}

/**
 * The value of one assignment, read the way Docker Compose's dotenv parser reads it.
 *
 * A quoted value runs to its closing quote and keeps any `#` inside; text after the quote is
 * ignored. An unquoted value ends at the first space followed by `#`, and trailing whitespace is
 * dropped, so `KEY=x  # note` is `x` while `KEY=x#y` is `x#y`. Reading ` # note` into the value
 * signed tokens with a secret the stack, reading the same line through compose, did not have.
 */
function envValueOf(rest: string): string {
  const value = rest.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const close = closingQuote(value, quote)
    if (close > 0) return value.slice(1, close)
  }
  const comment = value.indexOf(" #")
  return (comment === -1 ? value : value.slice(0, comment)).trimEnd()
}

/**
 * Parse `.env` text into key/value pairs, the one parser every reader of `.env` goes through.
 *
 * Follows Compose on what it shares with it: `#` comments, an optional `export `, quotes, inline
 * comments, and the last assignment of a key winning. Not interpolation or escape sequences in
 * double quotes, which nothing the CLI writes or reads relies on.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const assignment = splitAssignment(line)
    if (assignment !== null) out[assignment.key] = envValueOf(assignment.rest)
  }
  return out
}
