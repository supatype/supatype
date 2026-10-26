/**
 * Pick one language out of a localized column.
 *
 * At runtime the API hands back the whole locale record (`{ en: …, fr: … }`), because the column
 * holds every language at once and the API does not guess which one a caller wanted. So this is
 * the boundary where this app decides, and it checks the shape rather than assuming it.
 *
 * A locale's value is a string for a text column and a Lexical document for a rich text one, since
 * the engine normalises prose into a document on the way in. Both come back as the words to show.
 *
 * Returns null for a language nobody has written yet. Callers render that as absent rather than
 * falling back to another language: a reader asking for French and getting English has been told
 * the translation exists.
 */
export function localized(value: unknown, locale: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (!isObject(value)) return String(value)

  // A column that is not localized still arrives as its own object (a lexical root, say), so a
  // missing locale key only means something when some locale key is present.
  const looksLocalized = Object.keys(value).some((k) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k))
  if (!looksLocalized) return null

  const picked = value[locale]
  if (picked === null || picked === undefined) return null
  return typeof picked === "string" ? picked : plainText(picked)
}

/**
 * The words out of a Lexical document, or null if there are none.
 *
 * A rich text column holds a document, and a localized one holds a document per locale, because
 * the engine normalises whatever was written into one on the way in. This card has always shown a
 * one-line summary and has never rendered marks, so it takes the text and leaves the formatting.
 *
 * It reads `text` off any node that has one and recurses through `children`, rather than knowing
 * Lexical's node types. A document this app cannot render is still a document whose words it can
 * show, and guessing at the shape is what would break the next time a node type is added.
 */
function plainText(node: unknown): string | null {
  const parts: string[] = []

  const walk = (current: unknown): void => {
    if (!isObject(current)) return
    if (typeof current["text"] === "string") parts.push(current["text"])
    const children = current["children"] ?? current["root"]
    if (Array.isArray(children)) {
      for (const child of children) walk(child)
    } else if (children !== undefined) {
      walk(children)
    }
  }

  walk(node)
  const joined = parts.join("").trim()
  return joined === "" ? null : joined
}

/** Any object, arrays included, read key by key: what a JSON column can hold besides a scalar. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** A localized value with a stated fallback, for chrome that must render something. */
export function localizedOr(value: unknown, locale: string, fallback: string): string {
  return localized(value, locale) ?? fallback
}
