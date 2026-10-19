/**
 * Searching rows through PostgREST: case-insensitive substring matches that read every character
 * of the search literally.
 */

import type { FieldConfig, WidgetType } from "../config.js"

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
 * the client's `.or()`, which adds the parentheses. A field may be a JSON path (`title->>en`).
 */
export function anyFieldContains(fields: readonly string[], text: string): string {
  const pattern = quotedValue(containsPattern(text))
  return fields.map((field) => `${field}.ilike.${pattern}`).join(",")
}

/** Widgets whose column holds text, the only kind `ilike` applies to. */
const TEXT_WIDGETS: ReadonlySet<WidgetType> = new Set(["text", "textarea", "slug", "email", "url", "derivedText", "color"])

/**
 * What a text search of `names` matches on: each text column as it is, and each localized one by
 * its value in every locale (`title->>en`, `title->>fr`).
 *
 * A localized column is JSON, and `ilike` on it was `operator does not exist: jsonb ~~* unknown`:
 * the whole search of that model failed, so Pages and Sponsors were never found. A field that is
 * not text (a number, an enum, rich text, a reference) is left out rather than failing the rest. A
 * name with no field config is searched as it is, as it always was.
 */
export function searchColumns(fields: readonly FieldConfig[], names: readonly string[], locales: readonly string[]): string[] {
  return names.flatMap((name) => {
    const field = fields.find((f) => f.name === name)
    if (field === undefined) return [name]
    if (!TEXT_WIDGETS.has(field.widget)) return []
    return field.localized ? locales.map((locale) => `${name}->>${locale}`) : [name]
  })
}
