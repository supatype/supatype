import type { FieldConfig, ModelConfig } from "../config.js"
import { isJsonObject } from "./json.js"
import { foreignKeyColumn, serializeRecordForApi } from "./recordValues.js"

/**
 * The required fields a draft would be saved without.
 *
 * A draft may leave one empty: the table's NOT NULL holds only when the draft is published into the
 * live row. Saving such a draft is allowed, but the editor is asked first, so Publish is not where
 * they learn it cannot go live. Read off the write as it would be sent, so a blank slug its source
 * field fills is not counted missing. A boolean is never blank (unticked is a value), and a field
 * the form cannot write (read-only, hidden, the key, a list of related records) is not the
 * editor's to fill.
 */
export function emptyRequiredFields(model: ModelConfig, values: Record<string, unknown>): FieldConfig[] {
  const sent = serializeRecordForApi(model, values)
  return model.fields.filter(
    (field) => editorFills(model, field) && isBlank(sent[foreignKeyColumn(field) ?? field.name], field.localized),
  )
}

function editorFills(model: ModelConfig, field: FieldConfig): boolean {
  if (!field.required || field.readOnly === true || field.hidden === true) return false
  if (field.name === model.primaryKey) return false
  return field.widget !== "boolean" && field.widget !== "multirelation"
}

function isBlank(value: unknown, localized: boolean): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim() === ""
  // A localized field is blank when no translation holds anything.
  if (localized && isJsonObject(value)) return Object.values(value).every((v) => isBlank(v, false))
  return false
}
