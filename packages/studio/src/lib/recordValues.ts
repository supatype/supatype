import type { FieldConfig, ModelConfig } from "../config.js"
import { isJsonObject } from "./json.js"
import { slugifyInput } from "./slugify.js"

/**
 * A blank text value is absent, not empty.
 *
 * Postgres does not agree that `''` is missing: `char_length('') >= 5` is **false**, while the same
 * check against `NULL` is `NULL` and therefore passes. Studio treats a blank optional field as
 * absent, so the two only agree because every text widget happens to convert `""` to `null` on
 * change. That is a convention held in five separate components, and the day one of them stops
 * holding it, the browser passes a record the database then rejects. Normalising here makes it one
 * rule in one place, applied to whatever the widgets actually produced.
 */
function blankToNull(value: unknown): unknown {
  if (value === "") return null
  if (isJsonObject(value)) {
    // Localized columns are a locale map, so a blank translation is an absent one per locale.
    const entries = Object.entries(value)
    if (entries.some(([, v]) => v === "")) {
      return Object.fromEntries(entries.map(([k, v]) => [k, v === "" ? null : v]))
    }
  }
  return value
}

/** Fields whose blank value is genuinely a value, and must not be nulled. */
function keepsBlank(field: FieldConfig | undefined): boolean {
  return field?.widget === "json" || field?.widget === "code"
}

/** The text a slug is made from: the source's own, or its first filled translation. */
function sourceText(value: unknown): string {
  if (typeof value === "string") return value
  if (!isJsonObject(value)) return ""
  return Object.values(value).find((v): v is string => typeof v === "string" && v.trim() !== "") ?? ""
}

/**
 * A blank slug in the write, made from its source field the way the engine's trigger would.
 *
 * The trigger fills an empty slug only on INSERT. An UPDATE, and a publish, which copies a draft
 * into the live row with an UPDATE, leaves it NULL, and the column is NOT NULL. So a slug cleared in
 * the editor failed the save with raw SQL. A write that does not carry the slug is left without one.
 */
function fillBlankSlugs(model: ModelConfig, out: Record<string, unknown>): void {
  for (const field of model.fields) {
    if (field.widget !== "slug" || !(field.name in out) || out[field.name] !== null) continue
    const from = field.options?.["from"]
    const made = typeof from === "string" ? slugifyInput(sourceText(out[from])) : ""
    if (made !== "") out[field.name] = made
  }
}

/** Move each belongs-to relation's value to the foreign-key column PostgREST writes. */
function relationsToForeignKeys(model: ModelConfig, out: Record<string, unknown>): void {
  for (const field of model.fields) {
    if (field.widget !== "relation") continue
    if (field.options?.["cardinality"] !== "belongsTo") continue

    const fk =
      (typeof field.options?.["foreignKey"] === "string" && field.options["foreignKey"]) ||
      `${field.name}_id`

    if (field.name === fk) continue
    if (!(field.name in out)) continue

    out[fk] = out[field.name]
    delete out[field.name]
  }
}

/** Map Studio relation field names to PostgREST FK column names before insert/update. */
export function serializeRecordForApi(
  model: ModelConfig,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const byName = new Map(model.fields.map((f) => [f.name, f]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[key] = keepsBlank(byName.get(key)) ? value : blankToNull(value)
  }
  fillBlankSlugs(model, out)
  relationsToForeignKeys(model, out)
  return out
}
