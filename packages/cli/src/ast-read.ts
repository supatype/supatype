/**
 * Reading a schema AST that arrives untyped: from the engine's JSON, or passed on as `unknown` by
 * code that only needs one corner of it.
 *
 * Each reader takes the corner it needs with a check at every step, so a malformed entry is skipped
 * rather than throwing a TypeError out of `push`.
 */

import { isJsonObject } from "@supatype/shared"

/** The AST's models, each an object still to be read with checks. None when there is no models array. */
export function astModels(ast: unknown): Record<string, unknown>[] {
  if (!isJsonObject(ast) || !Array.isArray(ast["models"])) return []
  return ast["models"].filter(isJsonObject)
}

/**
 * The object found by following `path` from `value` (`objectAt(model, "annotations", "db")`), or
 * undefined when any step is missing or not an object.
 */
export function objectAt(value: unknown, ...path: string[]): Record<string, unknown> | undefined {
  let current = value
  for (const key of path) {
    if (!isJsonObject(current)) return undefined
    current = current[key]
  }
  return isJsonObject(current) ? current : undefined
}

/** True for an object with at least one key: a declared, non-empty map. */
export function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && Object.keys(value).length > 0
}
