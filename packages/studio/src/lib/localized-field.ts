/** Resolve a localized column or sub-field for display (falls back to default locale). */
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

/** Resolve a localized value for editing — current locale only, no fallback. */
export function getLocalizedEditValue(
  raw: unknown,
  localized: boolean,
  currentLocale: string,
): unknown {
  if (!localized) return raw
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw
  const locMap = raw as Record<string, unknown>
  return locMap[currentLocale] ?? null
}

function isEmptyLocalizedValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}

function lexicalPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  const n = node as Record<string, unknown>
  if (n["type"] === "text" && typeof n["text"] === "string") return n["text"]
  const children = n["children"]
  if (Array.isArray(children)) {
    return children.map(lexicalPlainText).join("")
  }
  const root = n["root"]
  if (root) return lexicalPlainText(root)
  return ""
}

function valueToPlaceholderText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    if (typeof obj["bucket"] === "string" && typeof obj["path"] === "string") return ""
    const text = lexicalPlainText(value)
    if (text) return text
    try {
      return JSON.stringify(value)
    } catch {
      return ""
    }
  }
  return ""
}

const PLACEHOLDER_MAX_LEN = 200

function truncatePlaceholder(text: string): string {
  if (text.length <= PLACEHOLDER_MAX_LEN) return text
  return `${text.slice(0, PLACEHOLDER_MAX_LEN)}…`
}

/**
 * Default-locale text shown as a placeholder when the active locale has no translation.
 * Returns undefined when fallback is unnecessary or unavailable.
 */
export function getLocalizedFallbackPlaceholder(
  raw: unknown,
  localized: boolean,
  currentLocale: string,
  defaultLocale: string,
): string | undefined {
  if (!localized || currentLocale === defaultLocale) return undefined
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const locMap = raw as Record<string, unknown>
  if (!isEmptyLocalizedValue(locMap[currentLocale])) return undefined
  const fallback = locMap[defaultLocale]
  if (isEmptyLocalizedValue(fallback)) return undefined
  const text = valueToPlaceholderText(fallback)
  if (!text) return undefined
  return truncatePlaceholder(text)
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
