/**
 * Pick one language out of a localized column.
 *
 * The generated row type says `string`, and at runtime the API hands back the whole locale record
 * (`{ en: …, fr: … }`), because the column holds every language at once and the API does not guess
 * which one a caller wanted. So the cast is the boundary where this app decides, not laziness.
 *
 * Returns null for a language nobody has written yet. Callers render that as absent rather than
 * falling back to another language: a reader asking for French and getting English has been told
 * the translation exists.
 */
export function localized(value: unknown, locale: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value !== "object") return String(value)

  const record = value as Record<string, unknown>
  // A column that is not localized still arrives as its own object (a lexical root, say), so a
  // missing locale key only means something when some locale key is present.
  const looksLocalized = Object.keys(record).some((k) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k))
  if (!looksLocalized) return null

  const picked = record[locale]
  return typeof picked === "string" ? picked : null
}

/** A localized value with a stated fallback, for chrome that must render something. */
export function localizedOr(value: unknown, locale: string, fallback: string): string {
  return localized(value, locale) ?? fallback
}
