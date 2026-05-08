/**
 * Client-side slugify aligned loosely with `_platform.slugify` in Postgres
 * (lower, strip non-alphanumeric except spaces/hyphens, collapse to hyphens).
 * Unicode letters are kept as lowercase letters where possible.
 */
export function slugifyInput(val: string): string {
  const trimmed = val.trim().toLowerCase()
  const nfd = trimmed.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  const cleaned = nfd.replace(/[^a-z0-9\s-]+/g, "")
  return cleaned.replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "")
}
