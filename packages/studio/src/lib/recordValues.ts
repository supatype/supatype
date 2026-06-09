import type { ModelConfig } from "../config.js"

/** Map Studio relation field names to PostgREST FK column names before insert/update. */
export function serializeRecordForApi(
  model: ModelConfig,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...values }

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

  return out
}
