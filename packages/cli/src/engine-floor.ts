/**
 * The engine version a schema needs, checked before the engine is asked to apply it.
 *
 * Field bounds and model constraints compile to CHECK constraints that call helper functions in
 * the `_supatype` schema, and only the engine creates those helpers. A CLI that emits the call
 * against an engine that does not create the function produces this, three times, and then gives
 * up:
 *
 *     Failed to apply migration
 *     Caused by: error returned from database:
 *       function _supatype.richtext_text(jsonb) does not exist
 *
 * Which says nothing about the cause. A project on `latest` is fine; the exposed case is a pin,
 * `versions: { engine: "0.1.9" }`, where the CLI moved and the engine did not.
 *
 * The check is conditional on the schema, not a flat floor: a schema that declares no bounds and
 * no model constraints works on an older engine, and refusing it would break projects for a
 * feature they do not use.
 *
 * It reads the pin rather than asking a binary for its version, because the pin is what both paths
 * resolve from: the native provider downloads that version, and the docker provider tags the
 * compose image with it. An unpinned project resolves to latest, which is at or above the floor by
 * definition, so there is nothing to check.
 */
import type { ExtractedSchemaAstV2, ModelAstV2 } from "./schema-ast-v2.js"

/** First engine release that creates the `_supatype` constraint helpers (schema-engine v0.2.0). */
export const ENGINE_MIN_FOR_BOUNDS = "0.2.0"

/**
 * Compare two dotted versions numerically. Returns <0, 0 or >0.
 *
 * Pre-release suffixes are dropped before comparing, so `0.2.0-rc.1` counts as `0.2.0`. That is
 * deliberate: a release candidate of the engine that creates the helpers does create them, and
 * refusing it would send someone testing a pre-release down a false trail.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n))
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Field paths in the schema that declare a bound, as `model.field`, for naming them in an error. */
function fieldsWithBounds(models: ModelAstV2[]): string[] {
  const found: string[] = []
  for (const model of models) {
    for (const [fieldName, field] of Object.entries(model.fields)) {
      if (Object.keys(field.validation ?? {}).length > 0) found.push(`${model.name}.${fieldName}`)
    }
  }
  return found
}

/** Models declaring a constraint, which compiles to a table-level CHECK. */
function modelsWithConstraints(models: ModelAstV2[]): string[] {
  return models
    .filter((model) => (model.annotations.db.constraints ?? []).length > 0)
    .map((model) => model.name)
}

/**
 * Everything in the schema that needs {@link ENGINE_MIN_FOR_BOUNDS}, or an empty array.
 *
 * Exported for the error message and for tests: a check nobody can see the input of is a check
 * that gets deleted the first time it is inconvenient.
 */
export function boundsRequiringHelpers(ast: ExtractedSchemaAstV2): string[] {
  return [...fieldsWithBounds(ast.models), ...modelsWithConstraints(ast.models)]
}

/**
 * Refuse a push whose schema needs helpers this engine does not create.
 *
 * Takes the pin from `versions.engine`, or undefined when unpinned. See the note above on why
 * that is the right source rather than the binary's own `--version`.
 */
export function assertEngineSupportsSchema(
  ast: ExtractedSchemaAstV2,
  pinnedEngineVersion: string | undefined,
): void {
  // Unpinned resolves to latest, and `local` points at a build whose version the config does not
  // know. Neither can be compared, and neither is the case that breaks.
  if (pinnedEngineVersion === undefined || pinnedEngineVersion === "local") return
  if (compareVersions(pinnedEngineVersion, ENGINE_MIN_FOR_BOUNDS) >= 0) return

  const needed = boundsRequiringHelpers(ast)
  if (needed.length === 0) return

  const shown = needed.slice(0, 3).join(", ")
  const more = needed.length > 3 ? `, and ${needed.length - 3} more` : ""
  throw new Error(
    `This schema declares bounds that need schema-engine ${ENGINE_MIN_FOR_BOUNDS} or newer, ` +
      `and this project pins ${pinnedEngineVersion}.\n\n` +
      `  Declared on: ${shown}${more}\n\n` +
      `Bounds compile to CHECK constraints that call helpers in the _supatype schema, and only ` +
      `engine ${ENGINE_MIN_FOR_BOUNDS}+ creates them. Applying this would fail inside Postgres ` +
      `with "function _supatype.richtext_text(jsonb) does not exist".\n\n` +
      `Raise or remove the pin in supatype.config.ts:\n` +
      `  versions: { engine: "${ENGINE_MIN_FOR_BOUNDS}" }   // or omit it to track latest`,
  )
}
