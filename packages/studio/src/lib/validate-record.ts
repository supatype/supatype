import type { FieldConfig, FieldValidation } from "../config.js"
import { countOf } from "./inflect.js"
import { isJsonObject } from "./json.js"
import { lengthOf } from "./measure-value.js"
import { widgetInputMessage } from "./widget-input.js"
import {
  describeConstraint,
  evaluate,
  type ModelConstraint,
} from "./evaluate-constraint.js"

/**
 * Every measure this module enforces.
 *
 * Tied to the contract by the assertion below, so adding a key to `FieldValidation` in
 * `@supatype/types` **fails Studio's build** until it is listed here, and listing it without
 * implementing it fails `bounds-parity.test.ts`. Between the two, a measure the engine can emit
 * cannot arrive in Studio and be quietly ignored, which is how bounds went unenforced the first
 * time.
 */
export const MEASURES = [
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "min",
  "max",
] as const

// Compile-time only: no measure exists in the contract that is missing from the list above.
type UnhandledMeasure = Exclude<keyof FieldValidation, (typeof MEASURES)[number]>
const _everyMeasureIsHandled: UnhandledMeasure extends never ? true : never = true
void _everyMeasureIsHandled

export interface FieldViolation {
  field: string
  label: string
  message: string
  /** Which translation breached, for a localized field. Absent when the field is not translated. */
  locale?: string
}

/**
 * Every value a field holds, paired with the locale it belongs to.
 *
 * The locale travels with the value because the message needs it: on a five-locale model,
 * "Headline must be 120 characters or fewer" leaves the author opening each translation in turn to
 * find which one is long.
 */
function valuesToCheck(raw: unknown, localized: boolean): Array<[string | null, unknown]> {
  if (!localized || !isJsonObject(raw)) return [[null, raw]]
  return Object.entries(raw)
}

function lengthMessage(rules: FieldValidation, value: unknown): string | null {
  const length = lengthOf(value)
  if (length === undefined) return null
  if (rules.maxLength !== undefined && length > rules.maxLength) {
    return `must be ${countOf(rules.maxLength, "character")} or fewer (currently ${length})`
  }
  // An empty string reaches the API as NULL, and a CHECK against NULL passes, so a blank optional
  // field is absent rather than short. Requiredness is a separate rule this does not police.
  if (rules.minLength !== undefined && length > 0 && length < rules.minLength) {
    return `must be at least ${countOf(rules.minLength, "character")} (currently ${length})`
  }
  return null
}

function itemsMessage(rules: FieldValidation, value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const { length } = value
  if (rules.maxItems !== undefined && length > rules.maxItems) {
    return `must have ${countOf(rules.maxItems, "item")} or fewer (currently ${length})`
  }
  if (rules.minItems !== undefined && length < rules.minItems) {
    return `must have at least ${countOf(rules.minItems, "item")} (currently ${length})`
  }
  return null
}

/** Comparable form of a range bound and a value: a number, or a timestamp for a temporal bound. */
function comparable(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (value instanceof Date) return value.getTime()
  return undefined
}

function rangeMessage(rules: FieldValidation, value: unknown): string | null {
  const actual = comparable(value)
  if (actual === undefined) return null
  for (const [bound, comparison, word] of [
    [rules.min, (a: number, b: number) => a < b, "or more"],
    [rules.max, (a: number, b: number) => a > b, "or less"],
  ] as const) {
    if (bound === undefined) continue
    const limit = comparable(bound)
    // A numeric bound against a date value, or the reverse, is not comparable. The extractor
    // refuses that pairing at push time, so there is nothing useful to say about it here.
    if (limit === undefined || typeof bound !== typeof value) continue
    if (comparison(actual, limit)) return `must be ${bound} ${word}`
  }
  return null
}

/** How one value breaks the field's declared bounds, or null when it does not. */
function boundsMessage(rules: FieldValidation, value: unknown): string | null {
  return lengthMessage(rules, value) ?? itemsMessage(rules, value) ?? rangeMessage(rules, value)
}

/**
 * The record's breaches of the bounds declared on its fields, checked before the write is sent.
 *
 * Postgres enforces the same bounds as a `CHECK`, so this changes no outcome, only which message the
 * editor sees: "Headline must be 120 characters or fewer" in place of a constraint-violation string
 * naming a generated constraint. Every bound here is one the database also holds, which is why a pass
 * cannot green-light a write the server would refuse.
 *
 * Input a widget could not read (a duration typed as `abc`, a latitude of 95) is refused here as
 * well. Those are not database rules, see `widget-input.ts`, but they stop a save the same way.
 */
export function validateRecord(
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
  constraints: readonly ModelConstraint[] = [],
): FieldViolation[] {
  const violations: FieldViolation[] = []

  for (const field of fields) {
    if (field.readOnly) continue
    const rules = field.validation ?? {}

    for (const [locale, value] of valuesToCheck(values[field.name], field.localized)) {
      const message = widgetInputMessage(field, value) ?? boundsMessage(rules, value)
      if (message !== null) {
        violations.push({
          field: field.name,
          label: field.label,
          message,
          ...(locale !== null && { locale }),
        })
        break
      }
    }
  }

  violations.push(...constraintViolations(constraints, fields, values))
  return violations
}

/**
 * Model constraints, checked per locale for a rule that reads a translated field.
 *
 * A rule naming exactly one column is attributed to that field, so Studio can report it on the input
 * rather than the form. One naming several is the model's, because no single input is at fault.
 */
function constraintViolations(
  constraints: readonly ModelConstraint[],
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
): FieldViolation[] {
  const out: FieldViolation[] = []
  for (const constraint of constraints) {
    const localized = constraint.columns.some(
      (column) => fields.find((f) => f.name === column)?.localized === true,
    )
    const locales = localized ? localesIn(constraint.columns, values) : [null]

    for (const locale of locales) {
      if (evaluate(constraint.rule, fields, values, locale) !== false) continue
      const [only] = constraint.columns
      const field = constraint.columns.length === 1 && only !== undefined ? only : constraint.name
      const label =
        constraint.columns.length === 1 && only !== undefined
          ? (fields.find((f) => f.name === only)?.label ?? only)
          : ""
      const message = describeConstraint(constraint.rule, fields, values, locale)
      out.push({
        field,
        label,
        // A single-column rule already names its field in the label, so the message drops the
        // subject to avoid "Headline Headline must be...".
        message: label === "" ? message : stripLeading(message, label),
        ...(locale !== null && { locale }),
      })
      break
    }
  }
  return out
}

/** Locales any of these columns carries a value for. */
function localesIn(columns: readonly string[], values: Record<string, unknown>): Array<string | null> {
  const seen = new Set<string>()
  for (const column of columns) {
    const raw = values[column]
    if (isJsonObject(raw)) {
      for (const key of Object.keys(raw)) seen.add(key)
    }
  }
  return seen.size > 0 ? [...seen] : [null]
}

function stripLeading(message: string, label: string): string {
  return message.startsWith(`${label} `) ? message.slice(label.length + 1) : message
}

/** One line for the edit view's error banner. */
export function describeViolations(violations: readonly FieldViolation[]): string {
  return violations
    .map((v) => (v.locale ? `${v.label} (${v.locale}) ${v.message}` : `${v.label} ${v.message}`))
    .join("; ")
}

/**
 * Each violation's message, keyed by the input it goes under.
 *
 * A cross-field rule has no single input to blame and stays in the banner alone, so a violation
 * whose `field` is not one of `fields` is left out.
 */
export function violationFieldErrors(
  fields: readonly FieldConfig[],
  violations: readonly FieldViolation[],
): Record<string, string> {
  return Object.fromEntries(
    violations
      .filter((v) => fields.some((f) => f.name === v.field))
      .map((v) => [v.field, v.locale ? `(${v.locale}) ${v.message}` : v.message]),
  )
}
