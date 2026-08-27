import type { FieldConfig } from "../config.js"
import { itemCountOf, lengthOf } from "./measure-value.js"

/**
 * Model constraints evaluated in the browser, against the same nodes the database compiled.
 *
 * The rule arrives as a structure rather than as SQL, which is the whole payoff for refusing raw
 * SQL: a string could only be sent to Postgres and waited on, whereas a node can be walked here to
 * say which rule failed and, when it names one column, on which field.
 *
 * Every verdict must match what the `CHECK` would decide. Two rules carry that:
 *
 * - **A missing operand yields `null`, and a rule containing one passes.** SQL three-valued logic:
 *   `NULL <= x` is `NULL`, and a `CHECK` evaluating to `NULL` passes. Treating absent as a failure
 *   would block saves the database accepts, which is the worse of the two ways to disagree.
 * - **A rule this evaluator does not understand passes.** It is an advisory second opinion; the
 *   database is what refuses. Guessing at an unknown node risks blocking a legal write, and a rule
 *   Studio cannot read is one the author still gets enforced, just later.
 */

/** A parsed constraint node. Shapes match the engine's `AccessRule` / `Operand` serde tags. */
export interface ConstraintNode {
  type?: string
  kind?: string
  [key: string]: unknown
}

export interface ModelConstraint {
  name: string
  columns: string[]
  rule: ConstraintNode
}

type Comparable = number | string | boolean

/** A field's value in the form, resolved through the locale map for a translated field. */
function valueOf(
  column: string,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
  locale: string | null,
): unknown {
  const field = fields.find((f) => f.name === column)
  const raw = values[column]
  if (!field?.localized || locale === null) return raw
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw
  return (raw as Record<string, unknown>)[locale]
}

function operandValue(
  operand: ConstraintNode,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
  locale: string | null,
): Comparable | null {
  switch (operand["kind"]) {
    case "column": {
      const value = valueOf(String(operand["name"]), fields, values, locale)
      if (value === null || value === undefined || value === "") return null
      if (typeof value === "number" || typeof value === "boolean") return value
      return String(value)
    }
    case "literal": {
      const value = operand["value"]
      return typeof value === "number" || typeof value === "boolean" || typeof value === "string"
        ? value
        : null
    }
    case "length":
    case "itemCount": {
      const value = valueOf(String(operand["column"]), fields, values, locale)
      if (value === null || value === undefined) return null
      const measured =
        operand["kind"] === "itemCount" ? itemCountOf(value) : lengthOf(value)
      return measured ?? null
    }
    default:
      return null
  }
}

/** Compare in the same order SQL would: numerically for numbers, as dates for date strings. */
function orderable(value: Comparable): number | string {
  if (typeof value === "number") return value
  if (typeof value === "boolean") return value ? 1 : 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : parsed
}

function compare(op: string, left: Comparable, right: Comparable): boolean | null {
  if (op === "like") {
    // `LIKE` is not a regex: `%` and `_` are its only wildcards.
    const pattern = String(right).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const source = `^${pattern.replace(/%/g, ".*").replace(/_/g, ".")}$`
    return new RegExp(source).test(String(left))
  }
  const a = orderable(left)
  const b = orderable(right)
  if (typeof a !== typeof b) return null
  switch (op) {
    case "eq":
      return a === b
    case "neq":
      return a !== b
    case "gt":
      return a > b
    case "gte":
      return a >= b
    case "lt":
      return a < b
    case "lte":
      return a <= b
    default:
      return null
  }
}

/**
 * Whether a rule holds. `null` means "cannot say", which passes, exactly as a `CHECK` evaluating to
 * `NULL` does.
 */
export function evaluate(
  rule: ConstraintNode,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
  locale: string | null = null,
): boolean | null {
  switch (rule["type"]) {
    case "compare": {
      const left = operandValue(rule["left"] as ConstraintNode, fields, values, locale)
      const right = operandValue(rule["right"] as ConstraintNode, fields, values, locale)
      if (left === null || right === null) return null
      return compare(String(rule["op"]), left, right)
    }

    case "nullCheck": {
      const value = operandValue(rule["operand"] as ConstraintNode, fields, values, locale)
      return rule["isNull"] === true ? value === null : value !== null
    }

    case "matches": {
      const value = valueOf(String(rule["column"]), fields, values, locale)
      if (value === null || value === undefined || value === "") return null
      try {
        // Postgres `~` is POSIX and JavaScript's is not. They agree on the patterns people write for
        // this, and where they do not the database is the one that decides.
        return new RegExp(String(rule["pattern"])).test(String(value))
      } catch {
        return null
      }
    }

    case "any":
    case "all": {
      const rules = (rule["rules"] as ConstraintNode[]) ?? []
      const verdicts = rules.map((inner) => evaluate(inner, fields, values, locale))
      if (rule["type"] === "any") {
        if (verdicts.some((v) => v === true)) return true
        return verdicts.some((v) => v === null) ? null : false
      }
      if (verdicts.some((v) => v === false)) return false
      return verdicts.some((v) => v === null) ? null : true
    }

    case "not": {
      const inner = evaluate(rule["rule"] as ConstraintNode, fields, values, locale)
      return inner === null ? null : !inner
    }

    default:
      // An unknown node is not a failure. The database still enforces it.
      return null
  }
}

const COMPARISON_WORDS: Record<string, string> = {
  eq: "must equal",
  neq: "must not equal",
  gt: "must be after",
  gte: "must be on or after",
  lt: "must be before",
  lte: "must be on or before",
  like: "must look like",
}

const NUMERIC_WORDS: Record<string, string> = {
  eq: "must equal",
  neq: "must not equal",
  gt: "must be more than",
  gte: "must be at least",
  lt: "must be less than",
  lte: "must be at most",
  like: "must look like",
}

function labelFor(column: string, fields: readonly FieldConfig[]): string {
  return fields.find((f) => f.name === column)?.label ?? column
}

/** How an operand reads in a message. */
function describeOperand(operand: ConstraintNode, fields: readonly FieldConfig[]): string {
  switch (operand["kind"]) {
    case "column":
      return labelFor(String(operand["name"]), fields)
    case "literal":
      return String(operand["value"])
    case "length":
      return `the length of ${labelFor(String(operand["column"]), fields)}`
    case "itemCount":
      return `the number of items in ${labelFor(String(operand["column"]), fields)}`
    default:
      return "this value"
  }
}

/**
 * Why a rule failed, in the author's terms.
 *
 * An `all` reports the **first failing part** rather than the whole rule: "Starts at must be on or
 * before Ends at" is actionable where "does not satisfy the constraint" is not. An `any` cannot be
 * narrowed that way, because no single part was required to hold, so it lists what would satisfy it.
 */
export function describeConstraint(
  rule: ConstraintNode,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
  locale: string | null = null,
): string {
  switch (rule["type"]) {
    case "compare": {
      const left = rule["left"] as ConstraintNode
      const right = rule["right"] as ConstraintNode
      const measured = left["kind"] === "length" || left["kind"] === "itemCount"
      const words = measured ? NUMERIC_WORDS : COMPARISON_WORDS
      return `${describeOperand(left, fields)} ${words[String(rule["op"])] ?? "must satisfy"} ${describeOperand(right, fields)}`
    }
    case "nullCheck":
      return `${describeOperand(rule["operand"] as ConstraintNode, fields)} ${
        rule["isNull"] === true ? "must be empty" : "must not be empty"
      }`
    case "matches":
      return `${labelFor(String(rule["column"]), fields)} must match ${String(rule["pattern"])}`
    case "all": {
      const rules = (rule["rules"] as ConstraintNode[]) ?? []
      const failing = rules.find((inner) => evaluate(inner, fields, values, locale) === false)
      return failing
        ? describeConstraint(failing, fields, values, locale)
        : "every part of this rule must hold"
    }
    case "any": {
      const rules = (rule["rules"] as ConstraintNode[]) ?? []
      const parts = rules.map((inner) => describeConstraint(inner, fields, values, locale))
      return `at least one of these must hold: ${parts.join("; ")}`
    }
    case "not":
      return `not: ${describeConstraint(rule["rule"] as ConstraintNode, fields, values, locale)}`
    default:
      return "this rule must hold"
  }
}
