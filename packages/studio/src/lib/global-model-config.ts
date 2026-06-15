import type { GlobalConfig, ModelConfig } from "../config.js"

/** Adapt a singleton global for model-scoped Studio views (schema, data, API docs). */
export function globalConfigAsModel(global: GlobalConfig): ModelConfig {
  const timestamps = global.fields.some(
    (f) => f.name === "created_at" || f.name === "updated_at",
  )
  return {
    name: global.name,
    label: global.label,
    labelPlural: global.label,
    tableName: global.tableName,
    apiPath: global.apiPath,
    primaryKey: "id",
    fields: global.fields,
    listColumns: [],
    searchFields: [],
    publishable: false,
    versioning: false,
    softDelete: false,
    timestamps,
    hasHooks: false,
  }
}
