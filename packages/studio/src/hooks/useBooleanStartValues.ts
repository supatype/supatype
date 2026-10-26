import { useEffect, type Dispatch, type SetStateAction } from "react"
import type { FieldConfig, ModelConfig } from "../config.js"
import { useApiQuery } from "./useApiQuery.js"
import { useProjectProxy, type SchemaTable } from "./useProjectProxy.js"

/**
 * A create form's boolean fields start with a real value: the column's default, else false.
 *
 * The toggle showed "No" for a value that was not there, and Save sent nothing for it, so a
 * required boolean with no default (self-host's Todo "Done") failed with a not-null violation
 * unless it was switched on and off again. The admin config does not carry column defaults, so
 * they are read from the table's columns, through the same introspection the Schema tab reads; a
 * caller who cannot read them gets false for every one, which is what the toggle shows.
 */

/** The columns of `table` whose default is a plain boolean literal, by column. */
export function booleanDefaults(table: SchemaTable | null): Record<string, boolean> {
  const defaults: Record<string, boolean> = {}
  for (const column of table?.columns ?? []) {
    const literal = column.default_value?.trim().toLowerCase()
    if (literal === "true" || literal === "false") defaults[column.name] = literal === "true"
  }
  return defaults
}

/** Each editable boolean field's starting value: its column default, else false. */
export function booleanStartValues(
  fields: readonly FieldConfig[],
  primaryKey: string,
  defaults: Record<string, boolean>,
): Record<string, boolean> {
  const start: Record<string, boolean> = {}
  for (const f of fields) {
    if (f.widget !== "boolean" || f.hidden || f.readOnly || f.name === primaryKey) continue
    start[f.name] = defaults[f.name] ?? false
  }
  return start
}

/** `start` under `values`: a value already set, by the editor or a copied draft, is kept. */
export function withStartValues(values: Record<string, unknown>, start: Record<string, boolean>): Record<string, unknown> {
  const unset = Object.entries(start).filter(([name]) => values[name] === undefined || values[name] === null)
  return unset.length === 0 ? values : { ...values, ...Object.fromEntries(unset) }
}

/** Seed a create form's boolean fields once the table's defaults are known. */
export function useBooleanStartValues(
  model: Pick<ModelConfig, "fields" | "primaryKey" | "tableName">,
  isCreate: boolean,
  setValues: Dispatch<SetStateAction<Record<string, unknown>>>,
): void {
  const proxy = useProjectProxy()
  const { data: table, loading } = useApiQuery(async () => {
    if (!isCreate) return null
    try {
      return (await proxy.introspect()).find((t) => t.name === model.tableName) ?? null
    } catch {
      return null
    }
  }, [proxy, model.tableName, isCreate])
  const { fields, primaryKey } = model
  useEffect(() => {
    if (!isCreate || loading) return
    const start = booleanStartValues(fields, primaryKey, booleanDefaults(table))
    setValues((prev) => withStartValues(prev, start))
  }, [isCreate, loading, table, fields, primaryKey, setValues])
}
