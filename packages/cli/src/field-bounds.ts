/**
 * What a declared bound means for each field kind, and the SQL it compiles to.
 *
 * **This table is the mechanism.** Bounds used to be compiled inside the modifier cases of
 * `type-extractor.ts`, which meant `MaxLength` became `char_length(col)` whatever the column turned
 * out to be: `char_length(text[])` does not exist, so the RFC's own `tags: MaxLength<string[], 10>`
 * produced SQL that fails `CREATE TABLE`. Worse, nine of twelve engine field structs had nowhere to
 * put a `check`, so the constraint was dropped by serde with no error anywhere in the chain.
 *
 * A table keyed by kind fixes the class of bug rather than the instances: a kind absent from
 * {@link BOUNDS_BY_KIND} throws, so a new field kind cannot be added without answering "what does a
 * bound mean here", and every answer is either an expression or a refusal with a named alternative.
 * There is no third outcome, which is what "no bound is ever silent" means in practice.
 */
import { FIELD_KINDS, type FieldKind, type FieldValidation } from "./schema-ast-v2.js"

/** Bounds as declared on the type, before anything knows what column they will land on. */
export interface DeclaredBounds {
  maxLength?: number
  minLength?: number
  maxItems?: number
  minItems?: number
  min?: number | string
  max?: number | string
}

/** What "length" counts, per storage. */
type LengthForm = "chars" | "octets" | "richText"
/** What "items" counts, per storage. */
type ItemsForm = "array" | "jsonbArray"
/** What a range compares against. Temporal forms name the cast, which is never `numeric`. */
type RangeForm = "numeric" | "timestamptz" | "date" | "timestamp" | "interval"

type BoundFamily = "length" | "items" | "range"

interface KindBounds {
  length?: LengthForm
  items?: ItemsForm
  range?: RangeForm
  /** Where to send someone whose bound this kind refuses. */
  instead?: Partial<Record<BoundFamily, string>>
}

const TEXTUAL: KindBounds = {
  length: "chars",
  instead: {
    items: "text has characters, not items; use MaxLength/MinLength",
    range: "text is not ordered numerically; use a model-level constraint if you need a comparison",
  },
}

const NUMERIC: KindBounds = {
  range: "numeric",
  instead: {
    length: "a number has no length; use Between to bound its value",
    items: "a number has no items; use Between to bound its value",
  },
}

const temporal = (range: RangeForm): KindBounds => ({
  range,
  instead: {
    length: "a date has no length; use Between with ISO-8601 string bounds",
    items: "a date has no items; use Between with ISO-8601 string bounds",
  },
})

const NO_BOUNDS = (why: string): KindBounds => ({
  instead: { length: why, items: why, range: why },
})

/**
 * What each bound means for each kind.
 *
 * `Record<FieldKind, KindBounds>` is the whole mechanism: it is **exhaustive by the compiler**, so
 * adding a kind to `FIELD_KINDS` fails the build here until someone says what `MaxLength`,
 * `MaxItems` and `Between` do for it. Composite kinds (`timestamps`, `publishable`, `softDelete`)
 * expand into real columns before a bound could apply, so they carry none, but they still have to
 * say so.
 */
const BOUNDS_BY_KIND: Record<FieldKind, KindBounds> = {
  text: TEXTUAL,
  email: TEXTUAL,
  url: TEXTUAL,
  slug: TEXTUAL,
  color: TEXTUAL,
  xml: TEXTUAL,
  ip: TEXTUAL,
  cidr: TEXTUAL,
  macaddr: TEXTUAL,
  tsQuery: TEXTUAL,
  tsVector: TEXTUAL,

  richText: {
    length: "richText",
    instead: {
      items: "rich text is measured in characters of plain text; use MaxLength/MinLength",
      range: "rich text is not ordered; use MaxLength/MinLength",
    },
  },

  bytes: {
    length: "octets",
    instead: {
      items: "a binary column has octets, not items; use MaxLength/MinLength",
      range: "a binary column is not ordered; use MaxLength/MinLength",
    },
  },

  integer: NUMERIC,
  smallInt: NUMERIC,
  bigInt: NUMERIC,
  float: NUMERIC,
  serial: NUMERIC,
  bigSerial: NUMERIC,
  decimal: NUMERIC,
  money: NUMERIC,

  datetime: temporal("timestamptz"),
  timestamp: temporal("timestamp"),
  date: temporal("date"),
  interval: temporal("interval"),

  array: {
    items: "array",
    instead: {
      length: "an array has items, not characters; use MaxItems/MinItems",
      range: "an array is not ordered; use MaxItems/MinItems",
    },
  },

  blocks: {
    items: "jsonbArray",
    instead: {
      length: "blocks are counted, not measured; use MaxItems/MinItems",
      range: "blocks are not ordered; use MaxItems/MinItems",
    },
  },

  // `json` is decided per field, not per kind: `JSON<Item[]>` takes item bounds and `JSON<{...}>`
  // takes none. {@link boundsForKind} applies that, which is why the entry here is the object case.
  json: NO_BOUNDS(
    "a JSON object has no single measure; bound a sub-field with a model-level constraint, " +
      "or declare the field as JSON<T[]> to bound its element count",
  ),
  button: NO_BOUNDS("a button is a composite value; bound a sub-field with a model-level constraint"),

  enum: NO_BOUNDS("the union already constrains the permitted values"),
  boolean: NO_BOUNDS("a boolean has two values and needs no bound"),
  uuid: NO_BOUNDS("a UUID is fixed width"),
  image: NO_BOUNDS("size and type limits belong on the bucket: fileSizeLimit and allowedMimeTypes"),
  file: NO_BOUNDS("size and type limits belong on the bucket: fileSizeLimit and allowedMimeTypes"),
  geo: NO_BOUNDS("a geometry is not measured this way"),
  vector: NO_BOUNDS("the dimension is already fixed by the type, as Vector<N>"),
  relation: NO_BOUNDS("bound the column on the model this relation points at"),
  custom: NO_BOUNDS("a plugin field declares its own storage; bounds are the plugin's to define"),

  timestamps: NO_BOUNDS("a composite expands into columns before a bound could apply"),
  publishable: NO_BOUNDS("a composite expands into columns before a bound could apply"),
  softDelete: NO_BOUNDS("a composite expands into columns before a bound could apply"),
}

/**
 * Re-exported for tests. Completeness is now the compiler's job, not a test's: this exists so the
 * matrix can assert it covers every kind, which is a different question from whether every kind is
 * classified.
 */
export const CLASSIFIED_KINDS: readonly FieldKind[] = FIELD_KINDS

/** `JSON<T[]>` counts elements; `JSON<{...}>` takes no bound. Anything else follows its kind. */
function boundsForKind(kind: FieldKind, jsonIsArray: boolean): KindBounds {
  const entry = BOUNDS_BY_KIND[kind]
  if (kind === "json" && jsonIsArray) {
    return {
      items: "jsonbArray",
      instead: {
        length: "a JSON array has items, not characters; use MaxItems/MinItems",
        range: "a JSON array is not ordered; use MaxItems/MinItems",
      },
    }
  }
  return entry
}

/** How a column is measured, once the kind has decided. */
export type MeasureForm = LengthForm | ItemsForm

export interface MeasureResolution {
  /** How to measure, when this kind can be measured this way. */
  form?: MeasureForm
  /** Why it cannot, and what to use instead. Present exactly when `form` is not. */
  instead?: string
}

/**
 * How a kind is measured, for one measure family.
 *
 * **The single answer for both paths.** `MaxLength<T, N>` on a field and `Length<"col">` inside a
 * model constraint have to agree about what "length" means for a given column, or the same schema
 * gets `char_length` in one place and `cardinality` in the other. A second table for the constraint
 * path is how `char_length(text[])` would come back, in a new file, having been fixed once already.
 */
export function measureFormFor(
  kind: FieldKind,
  measure: "length" | "items",
  options: { jsonIsArray?: boolean } = {},
): MeasureResolution {
  const entry = boundsForKind(kind, options.jsonIsArray === true)
  const form = measure === "length" ? entry.length : entry.items
  if (form !== undefined) return { form }
  return { instead: entry.instead?.[measure] ?? `a ${kind} field cannot be measured that way` }
}

const COLUMN = '"{name}"'

function lengthExpr(form: LengthForm): string {
  switch (form) {
    case "chars":
      return `char_length(${COLUMN})`
    case "octets":
      return `octet_length(${COLUMN})`
    case "richText":
      return `char_length(_supatype.richtext_text(${COLUMN}))`
  }
}

/**
 * `jsonb_array_length` raises `cannot get array length of a non-array` at insert time, so the type
 * guard is part of the constraint rather than an assumption about what callers send.
 */
function itemsClause(form: ItemsForm, comparisons: string[]): string {
  if (form === "array") {
    return comparisons.map((c) => `cardinality(${COLUMN}) ${c}`).join(" AND ")
  }
  const guarded = comparisons.map((c) => `jsonb_array_length(${COLUMN}) ${c}`).join(" AND ")
  return `jsonb_typeof(${COLUMN}) = 'array' AND ${guarded}`
}

function rangeLiteral(form: RangeForm, value: number | string): string {
  if (form === "numeric") return String(value)
  const cast = form === "timestamptz" ? "timestamptz" : form
  return `'${String(value).replace(/'/g, "''")}'::${cast}`
}

/** ISO-8601 date, date-time or a Postgres interval. Validated here so a bad literal is a CLI error. */
function isTemporalLiteral(form: RangeForm, value: string): boolean {
  if (form === "interval") return /^\s*\d+\s+[a-z]+(\s+\d+\s+[a-z]+)*\s*$/i.test(value)
  return !Number.isNaN(Date.parse(value))
}

export interface BoundsCompileResult {
  check?: string
  validation?: FieldValidation
}

function refuse(field: string, modifier: string, kind: FieldKind, hint: string | undefined): never {
  const tail = hint ? ` ${hint}.` : ""
  throw new Error(
    `Field "${field}": ${modifier} is not supported on a ${kind} field.${tail}`,
  )
}

/**
 * Compile declared bounds against the kind they landed on.
 *
 * Throws rather than dropping. A bound that cannot be honoured is a mistake in the schema, and the
 * failure it used to produce, silence, is the one failure this must not have.
 */
export function compileBounds(
  field: string,
  kind: FieldKind,
  bounds: DeclaredBounds,
  options: { jsonIsArray?: boolean } = {},
): BoundsCompileResult {
  const entry = boundsForKind(kind, options.jsonIsArray === true)
  const clauses: string[] = []
  const validation: FieldValidation = {}

  const { maxLength, minLength } = bounds
  if (maxLength !== undefined || minLength !== undefined) {
    const resolved = measureFormFor(kind, "length", options)
    if (resolved.form === undefined) {
      refuse(field, maxLength !== undefined ? "MaxLength" : "MinLength", kind, resolved.instead)
    }
    const expr = lengthExpr(resolved.form as LengthForm)
    if (maxLength !== undefined) {
      clauses.push(`${expr} <= ${maxLength}`)
      validation.maxLength = maxLength
    }
    if (minLength !== undefined) {
      clauses.push(`${expr} >= ${minLength}`)
      validation.minLength = minLength
    }
  }

  const { maxItems, minItems } = bounds
  const itemsResolved = measureFormFor(kind, "items", options)
  if (maxItems !== undefined || minItems !== undefined) {
    if (itemsResolved.form === undefined) {
      refuse(field, maxItems !== undefined ? "MaxItems" : "MinItems", kind, itemsResolved.instead)
    }
    const comparisons: string[] = []
    if (maxItems !== undefined) {
      comparisons.push(`<= ${maxItems}`)
      validation.maxItems = maxItems
    }
    if (minItems !== undefined) {
      comparisons.push(`>= ${minItems}`)
      validation.minItems = minItems
    }
    clauses.push(itemsClause(itemsResolved.form as ItemsForm, comparisons))
  }

  const { min, max } = bounds
  if (min !== undefined || max !== undefined) {
    if (!entry.range) refuse(field, "Between", kind, entry.instead?.range)
    for (const [bound, comparison] of [[min, ">="], [max, "<="]] as const) {
      if (bound === undefined) continue
      assertRangeShape(field, kind, entry.range, bound)
      clauses.push(`${COLUMN} ${comparison} ${rangeLiteral(entry.range, bound)}`)
    }
    if (min !== undefined) validation.min = min
    if (max !== undefined) validation.max = max
  }

  // Parenthesised only when there is something to bind, matching `mergeCheckConstraint`. Gratuitous
  // parentheses are not cosmetic here: the differ compares this text against what Postgres hands
  // back from `pg_get_constraintdef`, so every avoidable difference is a false "changed" on push.
  return {
    ...(clauses.length > 0 && { check: joinClauses(clauses) }),
    ...(Object.keys(validation).length > 0 && { validation }),
  }
}

function joinClauses(clauses: string[]): string {
  const [only] = clauses
  if (clauses.length === 1 && only !== undefined) return only
  return clauses.map((c) => `(${c})`).join(" AND ")
}

/** A number bounds a number and a string bounds a date. Crossing them is a mistake, not a cast. */
function assertRangeShape(field: string, kind: FieldKind, form: RangeForm, bound: number | string): void {
  const isNumeric = form === "numeric"
  if (isNumeric && typeof bound !== "number") {
    throw new Error(
      `Field "${field}": Between on a ${kind} field takes numbers, but "${bound}" is a string.`,
    )
  }
  if (!isNumeric && typeof bound !== "string") {
    throw new Error(
      `Field "${field}": Between on a ${kind} field takes ISO-8601 string bounds, but ${bound} is a number.`,
    )
  }
  if (!isNumeric && !isTemporalLiteral(form, bound as string)) {
    throw new Error(
      `Field "${field}": Between bound "${bound}" is not a valid ${form === "interval" ? "interval" : "ISO-8601 date"}.`,
    )
  }
}
