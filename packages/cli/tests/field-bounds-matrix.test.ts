import { describe, expect, it } from "vitest"
import { compileBounds } from "../src/field-bounds.js"
import type { FieldKind } from "../src/schema-ast-v2.js"

/**
 * Every field kind, against every bound family, asserted to do exactly one of two things.
 *
 * This is the test whose absence caused the whole defect. Nine of twelve field kinds accepted a
 * declared bound and enforced nothing, and no test noticed, because no test enumerated the kinds:
 * each was handled wherever someone happened to look.
 *
 * `MATRIX` is typed `Record<FieldKind, KindRow>`, so **completeness is the compiler's job**: adding
 * a kind to `FIELD_KINDS` fails the build in three places at once, here, in `BOUNDS_BY_KIND`, and
 * at any `scalar()` call using a name the registry does not know. No assertion can rot into
 * vacuous, because there is nothing to keep in sync by hand.
 *
 * Every cell is either an expression or a refusal. **A cell that is silently empty is the bug**, so
 * there is no way to express one.
 */

type Cell = { sql: string } | { refused: RegExp }

interface KindRow {
  /** `MaxLength<T, 5>` */
  length: Cell
  /** `MaxItems<T, 5>` */
  items: Cell
  /** `Between<T, ...>`, using whichever bound shape the kind accepts. */
  range: Cell
  /** The literal to bound with, when the kind takes a string rather than a number. */
  rangeBound?: string
}

const COL = '"{name}"'
const refusedAs = (alternative: string): Cell => ({ refused: new RegExp(alternative) })

const textual = (): KindRow => ({
  length: { sql: `char_length(${COL}) <= 5` },
  items: refusedAs("MaxItems is not supported"),
  range: refusedAs("Between is not supported"),
})

const numeric = (): KindRow => ({
  length: refusedAs("MaxLength is not supported"),
  items: refusedAs("MaxItems is not supported"),
  range: { sql: `${COL} <= 5` },
})

// An interval is bounded by a duration, not by a date. The matrix keeps them distinct because the
// extractor validates the literal shape per cast and would otherwise reject one of them at push time.
const temporal = (cast: string, bound = "2026-12-31"): KindRow => ({
  length: refusedAs("MaxLength is not supported"),
  items: refusedAs("MaxItems is not supported"),
  range: { sql: `${COL} <= '${bound}'::${cast}` },
  rangeBound: bound,
})

const unbounded = (why: string): KindRow => ({
  length: refusedAs(why),
  items: refusedAs(why),
  range: refusedAs(why),
})

const collection = (measure: string): KindRow => ({
  length: refusedAs("MaxItems"),
  items: { sql: measure },
  range: refusedAs("Between is not supported"),
})

const MATRIX: Record<FieldKind, KindRow> = {
  text: textual(),
  email: textual(),
  url: textual(),
  slug: textual(),
  color: textual(),
  xml: textual(),
  ip: textual(),
  cidr: textual(),
  macaddr: textual(),
  tsQuery: textual(),
  tsVector: textual(),

  richText: {
    length: { sql: `char_length(_supatype.richtext_text(${COL})) <= 5` },
    items: refusedAs("MaxItems is not supported"),
    range: refusedAs("Between is not supported"),
  },
  bytes: {
    length: { sql: `octet_length(${COL}) <= 5` },
    items: refusedAs("MaxItems is not supported"),
    range: refusedAs("Between is not supported"),
  },

  integer: numeric(),
  smallInt: numeric(),
  bigInt: numeric(),
  float: numeric(),
  serial: numeric(),
  bigSerial: numeric(),
  decimal: numeric(),
  money: numeric(),

  datetime: temporal("timestamptz"),
  timestamp: temporal("timestamp"),
  date: temporal("date"),
  interval: temporal("interval", "30 days"),

  array: collection(`cardinality(${COL}) <= 5`),
  blocks: collection(`jsonb_typeof(${COL}) = 'array' AND jsonb_array_length(${COL}) <= 5`),
  json: unbounded("JSON object has no single measure"),
  button: unbounded("composite value"),

  enum: unbounded("union already constrains"),
  boolean: unbounded("boolean has two values"),
  uuid: unbounded("fixed width"),
  image: unbounded("fileSizeLimit"),
  file: unbounded("fileSizeLimit"),
  geo: unbounded("not measured this way"),
  vector: unbounded("dimension is already fixed"),
  relation: unbounded("bound the column on the model"),
  custom: unbounded("plugin field declares its own storage"),
  timestamps: unbounded("composite expands into columns"),
  publishable: unbounded("composite expands into columns"),
  softDelete: unbounded("composite expands into columns"),
}

function assertCell(kind: FieldKind, family: string, cell: Cell, run: () => { check?: string }): void {
  if ("refused" in cell) {
    expect(
      run,
      `${kind}.${family} must refuse rather than silently accept a bound it cannot honour`,
    ).toThrow(cell.refused)
    return
  }
  const { check } = run()
  expect(check, `${kind}.${family} must compile to its own expression`).toBe(cell.sql)
}

describe("bounds matrix", () => {
  for (const [kind, row] of Object.entries(MATRIX) as Array<[FieldKind, KindRow]>) {
    describe(kind, () => {
      it("length", () => {
        assertCell(kind, "length", row.length, () => compileBounds("f", kind, { maxLength: 5 }))
      })

      it("items", () => {
        assertCell(kind, "items", row.items, () => compileBounds("f", kind, { maxItems: 5 }))
      })

      it("range", () => {
        const max = row.rangeBound ?? 5
        assertCell(kind, "range", row.range, () => compileBounds("f", kind, { max }))
      })
    })
  }

  it("treats JSON as a collection only when its type argument is an array", () => {
    // The one cell the kind alone cannot decide: the CLI reads it from the declared type.
    expect(compileBounds("f", "json", { maxItems: 5 }, { jsonIsArray: true }).check).toBe(
      `jsonb_typeof(${COL}) = 'array' AND jsonb_array_length(${COL}) <= 5`,
    )
  })
})
