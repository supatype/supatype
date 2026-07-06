import type { FieldConfig } from "../config.js"
import {
  getLocalizedEditValue,
  getLocalizedFallbackPlaceholder,
} from "./localized-field.js"

export interface SplitEditFieldsContext {
  primaryKey: string
  isCreate: boolean
  timestamps?: boolean
}

export function isMetadataField(field: FieldConfig, ctx: SplitEditFieldsContext): boolean {
  if (field.hidden) return false
  if (field.readOnly) return true
  if (!ctx.isCreate && field.name === ctx.primaryKey) return true
  if (field.widget === "uuid" && field.name === ctx.primaryKey) return true
  if (field.options?.["studioTimestampDefault"] === "now") return true
  if (
    ctx.timestamps &&
    (field.name === "created_at" || field.name === "updated_at") &&
    (field.readOnly || field.options?.["studioTimestampDefault"] === "now")
  ) {
    return true
  }
  return false
}

function sortFields(fields: FieldConfig[]): FieldConfig[] {
  return [...fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function splitEditFields(
  fields: FieldConfig[],
  ctx: SplitEditFieldsContext,
): { mainFields: FieldConfig[]; metaFields: FieldConfig[] } {
  const visible = sortFields(
    fields.filter((f) => {
      if (f.hidden) return false
      if (ctx.isCreate && f.name === ctx.primaryKey) return false
      return true
    }),
  )

  const mainFields = visible.filter((f) => !isMetadataField(f, ctx))
  const metaFields = visible
    .filter((f) => isMetadataField(f, ctx))
    .filter((f) => {
      if (ctx.isCreate && f.name === ctx.primaryKey) return false
      if (ctx.isCreate && (f.name === "created_at" || f.name === "updated_at")) return false
      return true
    })

  return { mainFields, metaFields }
}

export function getLocalizedFieldValue(
  values: Record<string, unknown>,
  field: FieldConfig,
  currentLocale: string,
  _defaultLocale: string,
): unknown {
  return getLocalizedEditValue(values[field.name], field.localized, currentLocale)
}

export function getLocalizedFieldPlaceholder(
  values: Record<string, unknown>,
  field: FieldConfig,
  currentLocale: string,
  defaultLocale: string,
): string | undefined {
  return getLocalizedFallbackPlaceholder(
    values[field.name],
    field.localized,
    currentLocale,
    defaultLocale,
  )
}
