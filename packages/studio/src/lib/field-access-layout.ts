import type { FieldConfig } from "../config.js"
import {
  isFieldCreatable,
  isFieldWritable,
  type StudioFieldAccess,
} from "../hooks/useStudioFieldAccess.js"

/**
 * Apply this caller's per-column access to a form's field list.
 *
 * Done as a transform of the field list rather than inside the widgets, because the two
 * behaviours it needs already exist there: `EditFormFieldList` honours `readOnly`, and a field
 * that is absent from the list is simply not rendered. So a column becomes a disabled input or
 * disappears without any component knowing about access rules.
 *
 * **A column no caller can supply is dropped from a create form**, not disabled. Rendering it
 * would be an input that cannot be satisfied, and for a required column, a form that can
 * never be submitted, failing with a not-null violation that names the constraint rather than
 * the rule. `create` is a distinct verdict precisely because of this case: an ownership write
 * rule is satisfiable on update by the owner and satisfiable on insert by nobody.
 *
 * **A readable-but-unwritable column is disabled, not hidden.** Its value is real and worth
 * showing; what the caller cannot do is change it.
 *
 * Fails open. With no answer from the server the list is returned untouched, so the interface
 * behaves exactly as it did before and the database still refuses what it should.
 */
export function applyFieldAccess(
  fields: FieldConfig[],
  access: StudioFieldAccess,
  table: string,
  isCreate: boolean,
): FieldConfig[] {
  if (!access.resolved) return fields
  if (access.fields[table] === undefined) return fields

  const result: FieldConfig[] = []
  for (const field of fields) {
    if (isCreate && !isFieldCreatable(access, table, field.name)) continue

    if (!isCreate && !isFieldWritable(access, table, field.name)) {
      result.push({ ...field, readOnly: true })
      continue
    }

    result.push(field)
  }

  return result
}
