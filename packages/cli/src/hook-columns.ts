/**
 * Which columns an after-hook's rows carry, per hooked table.
 *
 * After-hooks are fed from the database's change log, which no row or field rule filters, so the
 * row a hook receives would otherwise hold every column. A column with a field `read` rule is left
 * out unless the hook declares `columns: "all"`, so a hook that forwards a row to email or chat
 * cannot leak a column the person who saved it could never see. The listener also needs each
 * table's key to name a delivery.
 *
 * One function computes all of it, for the generated hook types and for whatever the server is sent,
 * so the two cannot disagree about which columns a hook sees.
 */
import { isJsonObject, type AfterHookColumns, type ManifestTableEntry } from "@supatype/shared"
import { isNonEmptyObject, objectAt } from "./ast-read.js"
import { astModelsOf, columnNameOf, resolveTableName, type AstModel } from "./augmentation-generator.js"
import type { AfterHookEvent } from "./hook-events.js"

export { isAfterHookEvent, type AfterHookEvent } from "./hook-events.js"

/**
 * The manifest's `tables` entry, with both events always said: `restrictedColumns` and `primaryKey`
 * in declaration order, and per after-hook what it declared (`"safe"` when it declared nothing).
 */
export interface HookTableColumns extends ManifestTableEntry {
  columns: Record<AfterHookEvent, AfterHookColumns>
}

/** Per table that declares a hook, keyed by the table as Postgres keeps it. */
export function hookTableColumns(ast: unknown): Record<string, HookTableColumns> {
  const out: Record<string, HookTableColumns> = {}
  for (const model of astModelsOf(ast)) {
    if (!isNonEmptyObject(objectAt(model, "annotations", "platform", "hooks"))) continue
    out[resolveTableName(model)] = modelHookColumns(model)
  }
  return out
}

/** {@link HookTableColumns} for one model, whether or not it declares a hook. */
export function modelHookColumns(model: AstModel): HookTableColumns {
  const hooks = objectAt(model, "annotations", "platform", "hooks")
  return {
    restrictedColumns: restrictedColumnsOf(model),
    primaryKey: primaryKeyOf(model),
    columns: {
      afterChange: declaredColumns(hooks?.["afterChange"]),
      afterDelete: declaredColumns(hooks?.["afterDelete"]),
    },
  }
}

/** The restricted columns `event`'s rows leave out: none when it declared `columns: "all"`. */
export function hiddenColumns(table: HookTableColumns, event: AfterHookEvent): string[] {
  return table.columns[event] === "all" ? [] : table.restrictedColumns
}

function declaredColumns(entry: unknown): AfterHookColumns {
  return isJsonObject(entry) && entry["columns"] === "all" ? "all" : "safe"
}

/**
 * Columns with a field `read` rule. A `write` rule alone hides nothing from a reader, so it does not
 * restrict a hook either. A rule on a relation names its foreign key column, which is what a row
 * carries.
 */
function restrictedColumnsOf(model: AstModel): string[] {
  const rules = objectAt(model, "annotations", "platform", "access", "fields")
  if (rules === undefined) return []
  return Object.entries(rules)
    .filter(([, rule]) => isJsonObject(rule) && rule["read"] !== undefined)
    .flatMap(([name]) => columnOf(model, name))
}

/** The key columns, in the order the fields are declared. */
function primaryKeyOf(model: AstModel): string[] {
  return Object.entries(model.fields)
    .filter(([, meta]) => meta["primaryKey"] === true)
    .flatMap(([name]) => columnOf(model, name))
}

/**
 * The column `name` names, as the generated Row type names it, or none for a relation that keeps
 * its key on the other table. A name that is no declared field is already a column (a field rule on
 * a relation is written against its foreign key).
 */
function columnOf(model: AstModel, name: string): string[] {
  const meta = model.fields[name]
  if (meta === undefined) return [name]
  const column = columnNameOf(name, meta)
  return column === null ? [] : [column]
}
