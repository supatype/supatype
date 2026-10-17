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
  if (!isLocaleMap(value)) return value
  return value[locale] ?? null
}

/**
 * The boundary: whether a value is the locale map or the bare value itself.
 *
 * A column that is not localized still arrives as its own object (a lexical root, say), so this
 * looks for a locale key rather than for an object. It checks the keys; the values are taken to be
 * the `T` the generated row type says they are, which is the one thing it cannot check.
 */
function isLocaleMap<T>(value: LocaleMap<T> | T): value is LocaleMap<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).some((k) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k))
  )
}
