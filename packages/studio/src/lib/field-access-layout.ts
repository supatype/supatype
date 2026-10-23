import type { FieldConfig } from "../config.js"
import {
  isFieldAllowedOnRecord,
  isFieldCreatable,
  type RecordFieldAccess,
  type StudioFieldAccess,
} from "../hooks/useStudioFieldAccess.js"

/**
 * Apply this caller's per-column access to a form's field list.
 *
 * Done as a transform of the field list rather than inside the widgets, because the behaviours it
 * needs already exist there: `EditFormFieldList` honours `readOnly`, `FieldWidget` shows `withheld`
 * as the padlock the list shows, and a field that is absent from the list is simply not rendered.
 * So a column becomes a disabled input, a padlock, or disappears without any component knowing
 * about access rules.
 *
 * **A column no caller can supply is dropped from a create form**, not disabled. Rendering it
 * would be an input that cannot be satisfied, and for a required column, a form that can
 * never be submitted, failing with a not-null violation that names the constraint rather than
 * the rule. A `row` create verdict keeps the field: the database judges it against the new row, so
 * a caller creating a record their rule accepts (one they own, say) can supply a value they could
 * not read on someone else's record.
 *
 * **On an existing record, `record` answers the per-row verdicts.** A column the caller cannot
 * read on this record is withheld: its value came back as null, and an empty input would claim
 * the record has none. A readable-but-unwritable column is disabled, not hidden: its value is real
 * and worth showing; what the caller cannot do is change it.
 *
 * Fails open. With no answer from the server the list is returned untouched, and a per-row verdict
 * the record has not answered behaves as allowed, so the database still refuses what it should.
 */
export function applyFieldAccess(
  fields: FieldConfig[],
  access: StudioFieldAccess,
  table: string,
  isCreate: boolean,
  record: RecordFieldAccess = {},
): FieldConfig[] {
  if (!access.resolved) return fields
  if (access.fields[table] === undefined) return fields
  if (isCreate) return fields.filter((field) => isFieldCreatable(access, table, field.name))
  return fields.map((field) => onRecord(field, access, table, record))
}

/** One field of an existing record's form, as this caller may use it on that record. */
function onRecord(
  field: FieldConfig,
  access: StudioFieldAccess,
  table: string,
  record: RecordFieldAccess,
): FieldConfig {
  if (!isFieldAllowedOnRecord(access, table, field.name, "read", record)) {
    return { ...field, readOnly: true, withheld: true }
  }
  if (!isFieldAllowedOnRecord(access, table, field.name, "write", record)) {
    return { ...field, readOnly: true }
  }
  return field
}

/**
 * The columns a save of this record must leave out of its body.
 *
 * Every column the caller cannot write on it, and every column it withholds from them: that value
 * reached the form as null, so sending it would blank a value the caller never saw, even where the
 * rule lets them write it. Leaving a column out keeps what the record holds, on an update and on a
 * draft alike, since a draft merges onto the live row.
 */
export function lockedColumns(
  access: StudioFieldAccess,
  table: string,
  record: RecordFieldAccess,
): string[] {
  return Object.keys(access.fields[table] ?? {}).filter(
    (column) =>
      !isFieldAllowedOnRecord(access, table, column, "read", record) ||
      !isFieldAllowedOnRecord(access, table, column, "write", record),
  )
}

/**
 * With no field access answer from the server: whether `column`'s `value` may be a withheld one.
 * True for a null in a column a REST response named as possibly masked, which is then neither
 * shown as empty nor saved, since nothing here can tell a withheld value from a missing one.
 */
export function isPossiblyWithheld(maskable: readonly string[], column: string, value: unknown): boolean {
  return maskable.includes(column) && (value === null || value === undefined)
}

/** An existing record's form fields, a possibly withheld one shown as the unknown padlock. */
export function withPossiblyWithheld(
  fields: FieldConfig[],
  maskable: readonly string[],
  values: Record<string, unknown>,
): FieldConfig[] {
  if (maskable.length === 0) return fields
  return fields.map((field) =>
    isPossiblyWithheld(maskable, field.name, values[field.name]) ? { ...field, readOnly: true, withheld: "unknown" } : field,
  )
}

/** The possibly withheld columns a save leaves out, so it cannot blank a value nobody saw. */
export function possiblyWithheldColumns(maskable: readonly string[], values: Record<string, unknown>): string[] {
  return maskable.filter((column) => isPossiblyWithheld(maskable, column, values[column]))
}
