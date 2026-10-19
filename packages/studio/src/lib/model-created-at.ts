import type { ModelConfig } from "../config.js"

/** Widgets holding a point in time, which Postgres can compare and truncate to a day. */
const TIME_WIDGETS: ReadonlySet<string> = new Set(["date", "datetime"])

/**
 * Whether the model with this table records when each row was created, as a date or time
 * `created_at`.
 *
 * The Dashboard's per-day chart, "this week" count and Recent list all read `created_at`. Not
 * every model has one: a model may declare no timestamps, or a field of its own by that name as
 * text, and asking for it there answered 400 (or 404 from the chart's function) on every load.
 */
export function hasCreatedAt(models: readonly ModelConfig[], tableName: string | undefined): boolean {
  const model = models.find((m) => m.tableName === tableName)
  return model?.fields.some((f) => f.name === "created_at" && TIME_WIDGETS.has(f.widget)) ?? false
}

/** The first model that has a date or time `created_at`, for a chart of rows created per day. */
export function firstModelWithCreatedAt(models: readonly ModelConfig[]): ModelConfig | undefined {
  return models.find((m) => hasCreatedAt(models, m.tableName))
}
