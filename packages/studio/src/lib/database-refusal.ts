import type { FieldConfig } from "../config.js"
import { SQLSTATE, sqlstateInMessage, unquoteColumn } from "./database-error.js"
import { foreignKeyColumn } from "./recordValues.js"
import { escapeRegExp } from "./utils.js"
import { widgetFor } from "./widget-input.js"

/**
 * A refused write in an editor's words, on the field it is about where the answer names one.
 *
 * Postgres words a refusal for whoever wrote the schema: `null value in column "slug" of relation
 * "speaker" violates not-null constraint`. Somebody saving a speaker needs "Slug is required" under
 * the slug input. Each kind of refusal a save can meet is told apart by its SQLSTATE, or by its
 * wording when the code did not travel (an RPC answer passes the message alone), and said plainly.
 * The server's own text is kept as `details`, behind a toggle, for whoever has to look further.
 */

/** A write the server refused: its message, and what came with it. */
export interface RefusalInput {
  message: string
  field?: string | undefined
  code?: string | undefined
  details?: string | undefined
  hint?: string | undefined
}

/** How a refusal is shown: the field and the words under it, the banner, and the raw text. */
export interface Explained {
  field: string | null
  message: string | null
  banner: string
  details: string | null
}

/** What an explainer found: the field it blames, if any, and the words. */
interface Finding {
  field?: FieldConfig | undefined
  /** Under the input, following the field's label. Required when `field` is set. */
  message?: string | undefined
  /** The banner when no field is blamed. */
  banner?: string | undefined
}

interface Refusal {
  error: RefusalInput
  fields: readonly FieldConfig[]
  values: Record<string, unknown>
}

type Explainer = (refusal: Refusal) => Finding

const FALLBACK = "The database refused this change."

function fieldNamed(fields: readonly FieldConfig[], column: string | undefined): FieldConfig | undefined {
  if (column === undefined) return undefined
  return fields.find((f) => f.name === column) ?? fields.find((f) => foreignKeyColumn(f) === column)
}

/** The columns a detail line's `Key (a, b)=(...)` names. */
function keyColumns(details: string | undefined): string[] {
  const list = /Key \(([^)]+)\)=/.exec(details ?? "")?.[1]
  return list === undefined ? [] : list.split(",").map(unquoteColumn)
}

const notNull: Explainer = ({ error, fields }) => {
  const quoted = /column ("(?:[^"]|"")+")/.exec(error.message)?.[1]
  const column = quoted === undefined ? undefined : unquoteColumn(quoted)
  const field = fieldNamed(fields, column)
  if (field !== undefined) return { field, message: "is required" }
  return { banner: column === undefined ? "A required field is empty." : `${column} is required.` }
}

const unique: Explainer = ({ error, fields }) => {
  const columns = keyColumns(error.details)
  const [only] = columns
  const field = columns.length === 1 ? fieldNamed(fields, only) : undefined
  if (field !== undefined) return { field, message: "is already used by another record" }
  if (columns.length > 1) return { banner: `Another record already has the same ${columns.join(", ")}.` }
  return { banner: "Another record already has one of these values." }
}

/** A constraint's name less its table's: `speaker_rating_check` on `speaker` is `rating_check`. */
function constraintOwnName(message: string, kind: string): string {
  const constraint = new RegExp(`${kind} constraint "([^"]+)"`).exec(message)?.[1] ?? ""
  const table = /relation "([^"]+)"/.exec(message)?.[1]
  return table !== undefined && constraint.startsWith(`${table}_`) ? constraint.slice(table.length + 1) : constraint
}

const check: Explainer = ({ error, fields }) => {
  const constraint = constraintOwnName(error.message, "check")
  const named = fields
    .filter((f) => new RegExp(`(^|_)${escapeRegExp(f.name)}(_|$)`).test(constraint))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (named !== undefined) return { field: named, message: "is not an allowed value" }
  return { banner: "A value breaks a rule the database holds for this record." }
}

const foreignKey: Explainer = ({ error, fields }) => {
  const details = error.details ?? ""
  const user = /still referenced from table "([^"]+)"/.exec(details)?.[1]
  if (user !== undefined) return { banner: `This record is still used by a ${user}, so it cannot be removed or changed.` }
  const target = /is not present in table "([^"]+)"/.exec(details)?.[1] ?? "record"
  const field = fieldNamed(fields, keyColumns(details)[0])
  if (field !== undefined) return { field, message: `points to a ${target} that does not exist` }
  return { banner: `A linked ${target} does not exist.` }
}

/** The one field holding exactly `raw`, as the form sent it. */
function fieldHolding(fields: readonly FieldConfig[], values: Record<string, unknown>, raw: string): FieldConfig | undefined {
  const holders = fields.filter((f) => {
    const value = values[f.name]
    return (typeof value === "string" || typeof value === "number") && String(value) === raw
  })
  return holders.length === 1 ? holders[0] : undefined
}

const invalidInput: Explainer = ({ error, fields, values }) => {
  const parsed = /invalid input (?:syntax|value) for (?:type|enum) ([^:]+): "(.*)"/.exec(error.message)
  const type = parsed?.[1] ?? "value"
  const raw = parsed?.[2] ?? ""
  const field = fieldHolding(fields, values, raw)
  if (field !== undefined) return { field, message: `is not a valid ${type}` }
  return { banner: parsed === null ? "A value is not in a form the database can read." : `"${raw}" is not a valid ${type}.` }
}

const tooLong: Explainer = ({ error, fields, values }) => {
  const limit = Number(/\((\d+)\)/.exec(error.message)?.[1] ?? Number.NaN)
  if (Number.isNaN(limit)) return { banner: "A value is longer than the database allows." }
  const long = fields.filter((f) => {
    const value = values[f.name]
    return typeof value === "string" && value.length > limit
  })
  const [only] = long
  if (long.length === 1 && only !== undefined) return { field: only, message: `must be ${limit} characters or fewer` }
  return { banner: `A value is longer than the database allows (${limit} characters).` }
}

/**
 * A privilege refusal, said as whichever rule made it: a row rule (row level security), a field
 * rule on one column, placed on that field, or otherwise the caller's access to the table.
 */
const permission: Explainer = ({ error, fields }) => {
  if (/row-level security/.test(error.message)) return { banner: "This change isn't allowed by the project's row rules." }
  const field = fieldNamed(fields, /permission denied for column "?([^"\s]+)"?/.exec(error.message)?.[1])
  if (field !== undefined) return { field, message: "can't be changed: its field rule doesn't allow it" }
  return { banner: "You do not have permission to make this change." }
}

/** The Studio proxy refusing the caller's Studio role, or a service-role-only upstream refusing them. */
const studioRole: Explainer = () => ({ banner: "This change isn't allowed by your Studio role." })

const GEOMETRY_MESSAGE = "is not a point the database can read. Enter a latitude and a longitude."

/** A PostGIS parse failure, a 500 with no code of its own, can only be about a point field. */
const geometry: Explainer = ({ fields, values }) => {
  const points = fields.filter((f) => widgetFor(f, values[f.name]) === "geopoint")
  const [only] = points
  return points.length === 1 && only !== undefined ? { field: only, message: GEOMETRY_MESSAGE } : {}
}

const BY_CODE: Record<string, Explainer> = {
  [SQLSTATE.notNullViolation]: notNull,
  [SQLSTATE.uniqueViolation]: unique,
  "23514": check,
  "23503": foreignKey,
  "22P02": invalidInput,
  "22007": invalidInput,
  "22001": tooLong,
  [SQLSTATE.insufficientPrivilege]: permission,
}

const BY_WORDING: ReadonlyArray<readonly [RegExp, Explainer]> = [
  [/violates not-null constraint/, notNull],
  [/violates unique constraint/, unique],
  [/violates check constraint/, check],
  [/violates foreign key constraint/, foreignKey],
  [/invalid input (?:syntax|value) for/, invalidInput],
  [/value too long for type/, tooLong],
  [/^Studio role "|service_role required/, studioRole],
  [/permission denied|not permitted|row-level security/, permission],
  [/invalid geometry/i, geometry],
]

function explainerFor(error: RefusalInput): Explainer | undefined {
  const code = error.code ?? sqlstateInMessage(error.message) ?? undefined
  const coded = code === undefined ? undefined : BY_CODE[code]
  return coded ?? BY_WORDING.find(([pattern]) => pattern.test(error.message))?.[1]
}

/** The server's own text, kept for the details toggle. */
function rawText(error: RefusalInput): string {
  return [error.message, error.details, error.hint].filter((part) => part !== undefined && part !== "").join("\n")
}

/** A refused write as an editor reads it. */
export function explainRefusal(
  error: RefusalInput,
  fields: readonly FieldConfig[],
  values: Record<string, unknown>,
): Explained {
  const explainer = explainerFor(error)
  if (explainer === undefined && error.field !== undefined) {
    // A field validator's refusal: already in the project's own words, about the field it names.
    return { field: error.field, message: error.message, banner: error.message, details: null }
  }
  const found = explainer?.({ error, fields, values }) ?? {}
  const details = rawText(error)
  if (found.field !== undefined && found.message !== undefined) {
    return { field: found.field.name, message: found.message, banner: `${found.field.label} ${found.message}`, details }
  }
  return { field: null, message: null, banner: found.banner ?? FALLBACK, details }
}

/** The message under the input a refusal names, keyed by its field; none when it names no field. */
export function fieldErrorOf(explained: Explained | null): Record<string, string> {
  if (explained === null || explained.field === null || explained.message === null) return {}
  return { [explained.field]: explained.message }
}
