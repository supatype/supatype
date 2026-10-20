import type { SupatypeClient } from "@supatype/client"
import type { ModelConfig } from "../config.js"
import { isJsonObject, isRecordOf, isShape, isString, type Guard } from "./json.js"
import { likeLiteral } from "./postgrest-search.js"
import { createRecord, duplicateValues, type RecordError } from "./publishing.js"
import { serializeRecordForApi } from "./recordValues.js"
import { SQLSTATE, unquoteColumn } from "./database-error.js"

/**
 * Duplicate: a new record from an existing one's values, valid under the table's unique rules.
 *
 * A copy of every value collided with any unique column, so Duplicate on a model with a unique
 * slug (Talk, Speaker, Page) answered 409 and made nothing. Which columns are unique is learnt from
 * the refusal rather than declared up front: Postgres names them in the detail line of a unique
 * violation, which covers a column-level `Unique<T>`, a declared unique index, and one added by hand
 * alike, and it costs nothing on a model with none.
 *
 * A slug is given the next free `-copy` value before the first insert, as an editor would: copied
 * as it was, it always collided, and every Duplicate logged a 409 in the browser console before the
 * retry made the copy. The retry stays for a slug taken between that look and the insert. Any other
 * unique value has no copy that means the same thing, so the copy opens in the create form with
 * that field cleared and marked, for the editor to fill in.
 */

/** A form to open in place of a created record: the copied values, and the fields to fill in. */
export interface RecordDraft {
  values: Record<string, unknown>
  fieldErrors: Record<string, string>
}

/** A draft as it comes back from router state, which is whatever the history entry holds. */
export const isRecordDraft: Guard<RecordDraft> = isShape({
  values: isJsonObject,
  fieldErrors: isRecordOf(isString),
})

export type DuplicateOutcome =
  | { kind: "created"; id: string }
  | { kind: "needsInput"; draft: RecordDraft }
  | { kind: "failed"; message: string }

/** Retries after a slug collided; each one moves past every value seen taken so far. */
const MAX_ATTEMPTS = 5

/** The columns a unique violation names (`Key (a, b)=(x, y) already exists.`), or none. */
export function uniqueViolationColumns(error: RecordError): string[] {
  if (error.code !== SQLSTATE.uniqueViolation || error.details === undefined) return []
  const match = /^Key \((.+?)\)=\(/.exec(error.details)
  return match?.[1] === undefined ? [] : match[1].split(",").map(unquoteColumn)
}

/** The base a `-copy` suffix goes on: the slug without any `-copy` or `-copy-N` it already has. */
function copyBase(slug: string): string {
  return slug.replace(/-copy(-\d+)?$/, "")
}

/** The first of `<base>-copy`, `<base>-copy-2`, ... that is not taken. */
export function nextFreeCopy(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(`${base}-copy`)) return `${base}-copy`
  let n = 2
  while (taken.has(`${base}-copy-${n}`)) n++
  return `${base}-copy-${n}`
}

/** The values of `column` already starting `<base>-copy`, as far as this caller can read them. */
async function takenCopies(client: SupatypeClient, model: ModelConfig, column: string, base: string): Promise<Set<string>> {
  const result = await client.from(model.tableName).select(column).like(column, `${likeLiteral(base)}-copy%`)
  const rows: unknown = result.data
  const values = Array.isArray(rows) ? rows.filter(isJsonObject).map((row) => row[column]) : []
  return new Set(values.filter(isString))
}

function isSlugColumn(model: ModelConfig, column: string): boolean {
  return model.fields.some((f) => f.name === column && f.widget === "slug")
}

/** The slug columns `copy` holds text in, which the copy moves to a free `-copy` value up front. */
function slugColumns(model: ModelConfig, copy: Record<string, unknown>): string[] {
  return model.fields.filter((f) => f.widget === "slug" && isString(copy[f.name]) && copy[f.name] !== "").map((f) => f.name)
}

/**
 * `copy` with each collided slug moved to its next free `-copy` value, or null when a collided
 * column is not a slug (or holds no text), which only the editor can choose a value for.
 */
async function withFreshSlugs(
  client: SupatypeClient,
  model: ModelConfig,
  copy: Record<string, unknown>,
  columns: readonly string[],
): Promise<Record<string, unknown> | null> {
  const next = { ...copy }
  for (const column of columns) {
    const current = copy[column]
    if (!isSlugColumn(model, column) || !isString(current)) return null
    const base = copyBase(current)
    const taken = await takenCopies(client, model, column, base)
    taken.add(current)
    next[column] = nextFreeCopy(base, taken)
  }
  return next
}

/** The create form for the copy, with the collided fields cleared and saying why. */
function draftWithout(model: ModelConfig, formValues: Record<string, unknown>, columns: readonly string[]): RecordDraft {
  const values = duplicateValues(model, formValues)
  const fieldErrors: Record<string, string> = {}
  for (const column of columns) {
    delete values[column]
    const label = model.fields.find((f) => f.name === column)?.label ?? column
    fieldErrors[column] = `${label} must be unique. Enter a new value for the copy.`
  }
  return { values, fieldErrors }
}

/** Create a copy of the record the form holds, or say what the editor has to fill in first. */
export async function duplicateRecord(
  client: SupatypeClient,
  model: ModelConfig,
  formValues: Record<string, unknown>,
): Promise<DuplicateOutcome> {
  const copied = duplicateValues(model, serializeRecordForApi(model, formValues))
  let copy = (await withFreshSlugs(client, model, copied, slugColumns(model, copied))) ?? copied
  let columns: string[] = []
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const created = await createRecord(client, model, copy)
    if (created.error === null) {
      return created.id === null ? { kind: "failed", message: "No data returned" } : { kind: "created", id: created.id }
    }
    columns = uniqueViolationColumns(created.error)
    if (columns.length === 0) return { kind: "failed", message: created.error.message }
    const next = await withFreshSlugs(client, model, copy, columns)
    if (next === null) break
    copy = next
  }
  return { kind: "needsInput", draft: draftWithout(model, formValues, columns) }
}
