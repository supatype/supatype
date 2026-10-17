import type { FieldConfig } from "../config.js"
import { isString } from "../lib/json.js"

/** A field option that should be a string, or undefined when it is absent or is not one. */
export function stringOption(config: FieldConfig, key: string): string | undefined {
  const value = config.options?.[key]
  return typeof value === "string" ? value : undefined
}

/** A field option that should be a list of strings, keeping only the entries that are. */
export function stringListOption(config: FieldConfig, key: string): string[] {
  const value = config.options?.[key]
  return Array.isArray(value) ? value.filter(isString) : []
}
