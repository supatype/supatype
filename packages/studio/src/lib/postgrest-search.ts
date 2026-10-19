/**
 * Searching rows through PostgREST: case-insensitive substring matches that read every character
 * of the search literally.
 */

/** `text` as a LIKE pattern matching only itself: `\`, `%` and `_` escaped with `\`, LIKE's default escape. */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** A pattern matching any value that contains `text`. */
export function containsPattern(text: string): string {
  return `%${likeLiteral(text)}%`
}

/** A value quoted for a PostgREST logic list, so a comma or parenthesis in it does not split the list. */
function quotedValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/**
 * The conditions of an `or=(...)` filter matching rows where any of `fields` contains `text`, for
 * the client's `.or()`, which adds the parentheses.
 */
export function anyFieldContains(fields: readonly string[], text: string): string {
  const pattern = quotedValue(containsPattern(text))
  return fields.map((field) => `${field}.ilike.${pattern}`).join(",")
}
