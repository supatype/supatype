/**
 * The owner columns the engine fills in itself.
 *
 * An auth user id that the model's `create` rule says must be the caller's (`Owner<"user_id">`,
 * also inside `Any` or `All`) defaults to `_supatype.jwt_uid()` when it declares no default of its
 * own. The rule refuses any other value, so the one a client could send is one the database
 * already knows. This mirrors the engine's `default_owner_to_caller` (parser/normaliser.rs), so
 * the CLI's generated `Insert` type agrees with the engine's and leaves the column optional.
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
 * The model's fields with the caller default added where the engine adds it, for the write types.
 * Fields that already declare a default, or are not auth user ids, are returned as they are.
 */
export function fieldsWithCallerDefaults(model: {
  fields: Record<string, Record<string, unknown>>
}): Record<string, Record<string, unknown>> {
  const owners = new Set(ownersInRule(objectAt(model, "annotations", "platform", "access")?.["create"]))
  if (owners.size === 0) return model.fields
  const entries = Object.entries(model.fields).map(([name, meta]) => {
    const defaulted = owners.has(name) && isAuthUserId(meta) && meta["default"] === undefined
    return [name, defaulted ? { ...meta, default: { expression: CALLER_ID_DEFAULT } } : meta] as const
  })
  return Object.fromEntries(entries)
}

/**
 * `fields` with the random uuid default taken off each auth user id the `create` rule makes the
 * caller's. Every uuid primary key without a default of its own is given `gen_random_uuid()`; on
 * these it would name no user and keep the engine's caller default from applying. Under any other
 * rule nothing else fills the column, so the key keeps it.
 */
export function withoutRandomDefaultOnCallerIds<F extends Record<string, unknown>>(
  fields: Record<string, F>,
  access: Record<string, unknown>,
): Record<string, F> {
  const owners = new Set(ownersInRule(access["create"]))
  if (owners.size === 0) return fields
  const entries = Object.entries(fields).map(([name, meta]) => {
    if (!owners.has(name) || !isAuthUserId(meta) || !isRandomUuidDefault(meta["default"])) return [name, meta] as const
    const withoutDefault = { ...meta }
    delete withoutDefault["default"]
    return [name, withoutDefault] as const
  })
  return Object.fromEntries(entries)
}

function isRandomUuidDefault(value: unknown): boolean {
  return isJsonObject(value) && value["kind"] === "genRandomUuid"
}
