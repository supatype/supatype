import type { TransformOptions } from "@supatype/client"

/**
 * Pick one language out of a localized column.
 *
 * The generated row type says `RichText`, and at runtime the API hands back the whole locale
 * record — `{ en: …, fr: … }` — because the column holds every language at once and the API does
 * not guess which one a caller wanted. So the cast is not laziness: it is the boundary where the
 * page decides, and the place to change if the types ever catch up.
 *
 * Returns null for a language nobody has written yet, which callers must render as absent rather
 * than falling back to another language. A reader asking for French and getting English has been
 * told the translation exists.
 */
export function localized(value: unknown, locale: string): unknown | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "object") return value
  const record = value as Record<string, unknown>
  // A column that is not localized still arrives as its own object (a lexical root, say), so the
  // locale key missing is only meaningful when some locale key is present.
  const looksLocalized = Object.keys(record).some((k) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k))
  if (!looksLocalized) return value
  return record[locale] ?? null
}

/** The storage reference a generated `ImageAsset` column carries. */
type StorageReference = { bucket: string; path: string; url: string }

/**
 * A public object's URL, optionally transformed on read.
 *
 * Built here rather than with the storage client because a Server Component has no session to
 * carry: a public bucket's object is reachable by URL alone, and an og:image must be, or the
 * crawler fetching it gets a 401.
 */
export function publicImageUrl(
  asset: unknown,
  transform?: TransformOptions,
): string | null {
  if (asset === null || asset === undefined || typeof asset !== "object") return null
  const ref = asset as Partial<StorageReference>
  if (typeof ref.url !== "string" || ref.url === "") return null
  if (transform === undefined) return ref.url

  const query = new URLSearchParams()
  if (transform.width !== undefined) query.set("width", String(transform.width))
  if (transform.height !== undefined) query.set("height", String(transform.height))
  if (transform.resize !== undefined) query.set("resize", transform.resize)
  if (transform.format !== undefined) query.set("format", transform.format)
  if (transform.quality !== undefined) query.set("quality", String(transform.quality))
  return `${ref.url}?${query.toString()}`
}
