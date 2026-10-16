/** What a localized column actually holds: every language at once. */
type LocaleMap<T> = { [locale: string]: T }

/**
 * Pick one language out of a localized column.
 *
 * The column holds every language at once and the API does not guess which one a caller wanted,
 * so choosing is the page's job. This used to take `unknown` and return `unknown`, because the
 * generated row type claimed a localized column was a bare `string` and the only honest thing a
 * helper could do was refuse to say. The generated type now describes the locale map, so this can
 * be typed, and a caller rendering the whole record is a compile error rather than `[object Object]`
 * on the page.
 *
 * Returns null for a language nobody has written yet, which callers render as absent rather than
 * falling back. A reader asking for French and getting English has been told the translation exists.
 */
export function localized<T>(value: LocaleMap<T> | T | null | undefined, locale: string): T | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "object") return value

  const record = value as Record<string, unknown>
  // A column that is not localized still arrives as its own object (a lexical root, say), so the
  // locale key missing is only meaningful when some locale key is present.
  const looksLocalized = Object.keys(record).some((k) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k))
  if (!looksLocalized) return value as T

  return (record[locale] as T | undefined) ?? null
}
