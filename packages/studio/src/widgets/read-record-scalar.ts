import { isJsonObject } from "../lib/json.js"

/** Raw string from a scalar/localized scalar field on a draft record (for cross-field previews). */
export function readScalarFromRecord(
  record: Record<string, unknown> | undefined,
  field: string,
  locale?: string,
  defaultLocale?: string,
): string {
  if (!record) return ""
  const v = record[field]
  if (v === null || v === undefined) return ""
  if (typeof v === "string" || typeof v === "number") return String(v)
  if (locale && defaultLocale && isJsonObject(v)) {
    const picked = v[locale] ?? v[defaultLocale]
    if (typeof picked === "string" || typeof picked === "number") return String(picked)
  }
  return ""
}
