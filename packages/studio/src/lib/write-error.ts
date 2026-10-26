import type { FieldConfig } from "../config.js"
import { SQLSTATE, unquoteColumn } from "./database-error.js"
import type { ModelConstraint } from "./evaluate-constraint.js"
import type { RecordError } from "./publishing.js"
import { describeViolations, validateRecord, violationFieldErrors } from "./validate-record.js"
import { widgetFor } from "./widget-input.js"

/**
 * A save the form or the server refused, reported in the banner and, where the answer allows,
 * under the input it is about. Shared by the record editor and the globals editor, so a refusal
 * reads the same in both.
 *
 * The server names the column outright when a field validator refuses. Otherwise Postgres sometimes
 * names it in the message (`null value in column "title" ... violates not-null constraint`), and a
 * PostGIS parse failure, which arrives as a 500 reading `parse error - invalid geometry`, can only
 * be about a point field. Anything else stays in the banner as the server worded it, since a guess
 * at the field would send the editor to the wrong input.
 */

/** Where a refused save is reported: the banner, and the input the refusal names. */
export interface RefusalReport {
  setError: (message: string | null) => void
  setFieldErrors: (errors: Record<string, string>) => void
}

/** Where a refusal goes: the field, the words under its input, and the banner's line. */
interface FieldRefusal {
  field: string
  message: string
  banner: string
}

const COLUMN_IN_MESSAGE = /column ("(?:[^"]|"")+")/
const INVALID_GEOMETRY = /invalid geometry/i
const GEOMETRY_MESSAGE = "is not a point the database can read. Enter a latitude and a longitude."

/** A refusal in Studio's own words, which follow the field's label as a validator's do. */
function reworded(field: FieldConfig, message: string): FieldRefusal {
  return { field: field.name, message, banner: `${field.label} ${message}` }
}

function namedField(error: RecordError, fields: readonly FieldConfig[]): FieldConfig | undefined {
  const quoted = COLUMN_IN_MESSAGE.exec(error.message)?.[1]
  const column = error.field ?? (quoted === undefined ? undefined : unquoteColumn(quoted))
  return fields.find((f) => f.name === column)
}

/** The one point field a geometry parse failure can be about; undefined unless there is exactly one. */
function pointField(fields: readonly FieldConfig[], values: Record<string, unknown>): FieldConfig | undefined {
  const points = fields.filter((f) => widgetFor(f, values[f.name]) === "geopoint")
  return points.length === 1 ? points[0] : undefined
}

function refusedField(
  error: RecordError,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
): FieldRefusal | null {
  const named = namedField(error, fields)
  if (named !== undefined) {
    if (error.code === SQLSTATE.notNullViolation) return reworded(named, "is required")
    return { field: named.name, message: error.message, banner: error.message }
  }
  const point = INVALID_GEOMETRY.test(error.message) ? pointField(fields, values) : undefined
  return point === undefined ? null : reworded(point, GEOMETRY_MESSAGE)
}

/** Report a refused write in the banner, and under the input it is about when that is known. */
export function reportRefusal(
  report: RefusalReport,
  error: RecordError,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
): void {
  const refusal = refusedField(error, fields, values)
  report.setError(refusal?.banner ?? error.message)
  if (refusal !== null) report.setFieldErrors({ [refusal.field]: refusal.message })
}

/** The form's own checks before a write, reported where each belongs; true when the form passes them. */
export function passesChecks(
  report: RefusalReport,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
  constraints: readonly ModelConstraint[] = [],
): boolean {
  const violations = validateRecord(fields, values, constraints)
  if (violations.length === 0) return true
  report.setError(describeViolations(violations))
  report.setFieldErrors(violationFieldErrors(fields, violations))
  return false
}
