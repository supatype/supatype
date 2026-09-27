import type { TransformOptions } from "@supatype/client"

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

/** What an image or file column carries: what `storage.upload()` produced, and where it went. */
type StorageReference = { bucket: string; path: string }

/** Where this project's storage API lives, for building a public object URL without a session. */
const STORAGE_URL = `${process.env["NEXT_PUBLIC_SUPATYPE_URL"] ?? ""}/storage/v1`

/**
 * A public object's URL, optionally transformed on read.
 *
 * Built here rather than with the storage client because a Server Component has no session to
 * carry: a public bucket's object is reachable by URL alone, and an og:image must be, or the
 * crawler fetching it gets a 401.
 *
 * It is derived rather than read off the column. This previously expected a `url` field, declared
 * in a fourth private copy of the asset shape, and returned null whenever it was absent, which was
 * always, so every og:image silently resolved to nothing. A URL is not stored because a stored one
 * goes stale and bakes in the host; the bucket and path are enough to rebuild it anywhere.
 */
export function publicImageUrl(
  asset: StorageReference | null | undefined,
  transform?: TransformOptions,
): string | null {
  if (asset === null || asset === undefined) return null
  if (typeof asset.bucket !== "string" || typeof asset.path !== "string") return null

  const url = `${STORAGE_URL}/object/public/${asset.bucket}/${asset.path}`
  if (transform === undefined) return url

  const query = new URLSearchParams()
  if (transform.width !== undefined) query.set("width", String(transform.width))
  if (transform.height !== undefined) query.set("height", String(transform.height))
  if (transform.resize !== undefined) query.set("resize", transform.resize)
  if (transform.format !== undefined) query.set("format", transform.format)
  if (transform.quality !== undefined) query.set("quality", String(transform.quality))
  return `${url}?${query.toString()}`
}
