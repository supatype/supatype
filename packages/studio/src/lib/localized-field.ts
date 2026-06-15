/** Resolve a localized column or sub-field for the active Studio locale. */
export function getLocalizedFieldValue(
  raw: unknown,
  localized: boolean,
  currentLocale: string,
  defaultLocale: string,
): unknown {
  if (!localized) return raw
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw
  const locMap = raw as Record<string, unknown>
  return locMap[currentLocale] ?? locMap[defaultLocale] ?? null
}

/** Merge a locale-specific value into a localized column or sub-field. */
export function setLocalizedFieldValue(
  raw: unknown,
  localized: boolean,
  currentLocale: string,
  value: unknown,
): unknown {
  if (!localized) return value
  const existing =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  return { ...existing, [currentLocale]: value }
}
