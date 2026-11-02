/**
 * The owner columns the engine fills in itself.
 *
 * An auth user id that the model's `create` rule says must be the caller's (`Owner<"user_id">`,
 * also inside `Any` or `All`) defaults to `_supatype.jwt_uid()` when it declares no default of its
 * own. The rule refuses any other value, so the one a client could send is one the database
 * already knows. This mirrors the engine's `default_owner_to_caller` (parser/normaliser.rs), so
 * the CLI's generated `Insert` type agrees with the engine's and leaves the column optional.
 * The extractor asks the same question ({@link callerOwnedIds}) before it gives a uuid key the
 * random default, which on such a column would name no user.
 */

import { isJsonObject } from "@supatype/shared"
import { objectAt } from "./ast-read.js"

/** The engine's default for a caller-owned auth user id (`CALLER_ID_DEFAULT`). */
export const CALLER_ID_DEFAULT = "_supatype.jwt_uid()"

/** Every field an owner rule names in `rule`, looking inside `any` and `all`. */
function ownersInRule(rule: unknown): string[] {
  if (!isJsonObject(rule)) return []
  if (rule["type"] === "owner") return typeof rule["field"] === "string" ? [rule["field"]] : []
  if ((rule["type"] === "any" || rule["type"] === "all") && Array.isArray(rule["rules"])) {
    return rule["rules"].flatMap(ownersInRule)
  }
  return []
}

function isAuthUserId(meta: Record<string, unknown>): boolean {
  return objectAt(meta, "annotations", "db")?.["authUserId"] === true
}

/**
 * The auth user ids `createRule` makes the caller's: fields an owner rule names (also inside `any`
 * or `all`) that hold an auth user id. The engine defaults each to the caller when it declares no
 * default of its own.
 */
export function callerOwnedIds(createRule: unknown, fields: Record<string, Record<string, unknown>>): Set<string> {
  return new Set(
    ownersInRule(createRule).filter((name) => {
      const meta = fields[name]
      return meta !== undefined && isAuthUserId(meta)
    }),
  )
}

/**
 * The model's fields with the caller default added where the engine adds it, for the write types.
 * Fields that already declare a default, or are not caller-owned auth user ids, are returned as they are.
 */
export function fieldsWithCallerDefaults(model: {
  fields: Record<string, Record<string, unknown>>
}): Record<string, Record<string, unknown>> {
  const owned = callerOwnedIds(objectAt(model, "annotations", "platform", "access")?.["create"], model.fields)
  if (owned.size === 0) return model.fields
  const entries = Object.entries(model.fields).map(([name, meta]) => {
    const defaulted = owned.has(name) && meta["default"] === undefined
    return [name, defaulted ? { ...meta, default: { expression: CALLER_ID_DEFAULT } } : meta] as const
  })
  return Object.fromEntries(entries)
}
