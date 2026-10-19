import type { ModelConfig } from "../config.js"
import { isJsonObject } from "./json.js"

/** The columns a record is called by, in the order a link to it looks for one. */
const NAME_COLUMNS = ["name", "title", "email", "label"]

/**
 * What a record is called where it is linked to (Dashboard's recent list, Jump to): its first
 * naming column with text in it, in `currentLocale` falling back to `defaultLocale` for a localized
 * one. Null when none has text. `String()` of a localized title read `[object Object]`.
 */
export function recordLabel(
  row: Record<string, unknown>,
  model: Pick<ModelConfig, "fields"> | undefined,
  currentLocale: string,
  defaultLocale: string,
): string | null {
  for (const column of NAME_COLUMNS) {
    const localized = model?.fields.some((f) => f.name === column && f.localized) === true
    const value = getLocalizedFieldValue(row[column], localized, currentLocale, defaultLocale)
    if (typeof value === "string" && value.trim() !== "") return value
    if (typeof value === "number") return String(value)
  }
  return null
}

/** Resolve a localized column or sub-field for display (falls back to default locale). */
export function getLocalizedFieldValue(
  raw: unknown,
  localized: boolean,
  currentLocale: string,
  defaultLocale: string,
): unknown {
  if (!localized || !isJsonObject(raw)) return raw
  return raw[currentLocale] ?? raw[defaultLocale] ?? null
}

/** Resolve a localized value for editing, current locale only, no fallback. */
export function getLocalizedEditValue(
  raw: unknown,
  localized: boolean,
  currentLocale: string,
): unknown {
  if (!localized || !isJsonObject(raw)) return raw
  return raw[currentLocale] ?? null
}

function isEmptyLocalizedValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}

function lexicalPlainText(n: unknown): string {
  if (!isJsonObject(n)) return ""
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
    // A storage reference names a file, which has no text to show.
    if (isJsonObject(value) && typeof value["bucket"] === "string" && typeof value["path"] === "string") return ""
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
  if (!isJsonObject(raw)) return undefined
  if (!isEmptyLocalizedValue(raw[currentLocale])) return undefined
  const fallback = raw[defaultLocale]
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
  const existing = isJsonObject(raw) ? raw : {}
  return { ...existing, [currentLocale]: value }
}
