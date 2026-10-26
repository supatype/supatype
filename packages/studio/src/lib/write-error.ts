import type { FieldConfig } from "../config.js"
import { explainRefusal, fieldErrorOf, type RefusalInput } from "./database-refusal.js"
import type { ModelConstraint } from "./evaluate-constraint.js"
import { describeViolations, validateRecord, violationFieldErrors } from "./validate-record.js"

/**
 * A save the form or the server refused, reported in the banner and, where the answer allows,
 * under the input it is about. Shared by every editor that saves (the record editor, the globals
 * editor and the data browser), so a refusal reads the same in each. What a refusal says is
 * `database-refusal.ts`'s; this is where it goes.
 */

/** Where a refused save is reported: the banner, its details toggle, and the input it names. */
export interface RefusalReport {
  setError: (message: string | null) => void
  setFieldErrors: (errors: Record<string, string>) => void
  /** The server's own text, behind the banner's details toggle. */
  setDetails: (details: string | null) => void
}

/** Clear the last refusal before another try. */
export function clearRefusal(report: RefusalReport): void {
  report.setError(null)
  report.setDetails(null)
  report.setFieldErrors({})
}

/** Report a refused write in the banner, and under the input it is about when that is known. */
export function reportRefusal(
  report: RefusalReport,
  error: RefusalInput,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
): void {
  const explained = explainRefusal(error, fields, values)
  report.setError(explained.banner)
  report.setDetails(explained.details)
  report.setFieldErrors(fieldErrorOf(explained))
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
  report.setDetails(null)
  report.setFieldErrors(violationFieldErrors(fields, violations))
  return false
}
