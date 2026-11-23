/**
 * The values realtime used to send in Postgres's text form, where REST sends JSON.
 *
 * wal2json writes every column with its type's text output, and with `numeric-data-types-as-string`
 * the numerics are strings too. The columns it quotes and this service passed through were these:
 * `jsonb` arrived as a JSON string rather than the value, and `timestamptz` as
 * `2024-01-01 12:00:00+00`, which Safari and Firefox read as `Invalid Date`. REST (PostgREST, which
 * serialises with `to_json`) sends `2024-01-01T12:00:00+00:00` and the parsed json, so the same row
 * had two shapes depending on how it was read.
 */
import { describe, expect, it } from "vitest"
import { parseWal2json } from "../src/replication.js"
import { exactColumnsOf, valueForColumn } from "../src/exact-columns.js"
import { matchesFilter } from "../src/filter-match.js"
import type { WalChange } from "../src/types.js"

function insert(columns: Record<string, [string, unknown]>): string {
  return JSON.stringify({
    change: [
      {
        kind: "insert",
        schema: "public",
        table: "auction",
        columnnames: Object.keys(columns),
        columntypes: Object.values(columns).map(([type]) => type),
        columnvalues: Object.values(columns).map(([, value]) => value),
      },
    ],
  })
}

describe("jsonb and json", () => {
  it("arrive as the value, not as the JSON text", () => {
    const [change] = parseWal2json(insert({ meta: ["jsonb", '{"a": 1, "b": [true, null]}'], raw: ["json", "[1, 2]"] }))
    expect(change?.newRecord).toEqual({ meta: { a: 1, b: [true, null] }, raw: [1, 2] })
  })

  it("keeps a json string literal as a string, and a json null as null", () => {
    expect(valueForColumn('"abc"', "jsonb")).toBe("abc")
    expect(valueForColumn("null", "jsonb")).toBeNull()
  })

  it("leaves text that is not JSON as it came, rather than failing the change", () => {
    expect(valueForColumn("{not json", "jsonb")).toBe("{not json")
  })

  it("leaves a SQL null alone", () => {
    expect(valueForColumn(null, "jsonb")).toBeNull()
  })

  it("parses an array of jsonb", () => {
    expect(valueForColumn('{"{\\"a\\": 1}","[1, 2]",NULL}', "jsonb[]")).toEqual([{ a: 1 }, [1, 2], null])
  })
})

describe("timestamptz", () => {
  it("is ISO 8601 with a T and a full offset, as REST sends it", () => {
    expect(valueForColumn("2024-01-01 12:00:00+00", "timestamp with time zone")).toBe("2024-01-01T12:00:00+00:00")
  })

  it("keeps microseconds, which a Date would cut to milliseconds", () => {
    expect(valueForColumn("2024-01-01 12:00:00.123456+00", "timestamp with time zone")).toBe(
      "2024-01-01T12:00:00.123456+00:00",
    )
  })

  it("keeps a non-zero offset, with its minutes", () => {
    expect(valueForColumn("2024-06-01 12:00:00+05:30", "timestamptz")).toBe("2024-06-01T12:00:00+05:30")
    expect(valueForColumn("2024-06-01 12:00:00-08", "timestamptz")).toBe("2024-06-01T12:00:00-08:00")
  })

  it("is read by Date, which is what the browsers failed on", () => {
    const value = valueForColumn("2024-01-01 12:00:00+00", "timestamp with time zone")
    expect(new Date(String(value)).toISOString()).toBe("2024-01-01T12:00:00.000Z")
  })

  it("accepts a declared precision", () => {
    expect(valueForColumn("2024-01-01 12:00:00.123+00", "timestamp(3) with time zone")).toBe(
      "2024-01-01T12:00:00.123+00:00",
    )
  })

  it("leaves infinity as Postgres writes it", () => {
    expect(valueForColumn("infinity", "timestamptz")).toBe("infinity")
    expect(valueForColumn("-infinity", "timestamptz")).toBe("-infinity")
  })

  it("leaves a value it does not recognise alone", () => {
    expect(valueForColumn("0044-03-15 12:00:00+00 BC", "timestamptz")).toBe("0044-03-15 12:00:00+00 BC")
  })

  it("converts an array of them", () => {
    expect(valueForColumn('{"2024-01-01 00:00:00+00","2024-01-02 00:00:00+00",NULL}', "timestamp with time zone[]")).toEqual([
      "2024-01-01T00:00:00+00:00",
      "2024-01-02T00:00:00+00:00",
      null,
    ])
  })
})

describe("timestamp without a zone", () => {
  it("is ISO 8601 with a T and no offset", () => {
    expect(valueForColumn("2024-01-01 12:00:00", "timestamp without time zone")).toBe("2024-01-01T12:00:00")
    expect(valueForColumn("2024-01-01 12:00:00.5", "timestamp")).toBe("2024-01-01T12:00:00.5")
  })

  it("converts an array of them", () => {
    expect(valueForColumn('{"2024-01-01 12:00:00"}', "timestamp without time zone[]")).toEqual(["2024-01-01T12:00:00"])
  })
})

describe("timetz", () => {
  it("gets the full offset REST sends", () => {
    expect(valueForColumn("12:00:00+00", "time with time zone")).toBe("12:00:00+00:00")
    expect(valueForColumn("12:00:00.25-05:30", "timetz")).toBe("12:00:00.25-05:30")
  })
})

describe("types that already match REST", () => {
  it("leaves date, time, text and uuid exactly as they arrive", () => {
    expect(valueForColumn("2024-01-01", "date")).toBe("2024-01-01")
    expect(valueForColumn("12:00:00", "time without time zone")).toBe("12:00:00")
    expect(valueForColumn("2024-01-01 12:00:00", "text")).toBe("2024-01-01 12:00:00")
  })
})

describe("array literals", () => {
  it("reads quoted elements with escaped quotes and backslashes", () => {
    expect(valueForColumn('{"\\"x\\""}', "jsonb[]")).toEqual(["x"])
  })

  it("leaves a literal it cannot read as it came", () => {
    expect(valueForColumn("{unterminated", "timestamptz[]")).toBe("{unterminated")
  })

  it("reads a nested (two dimensional) array", () => {
    expect(valueForColumn('{{"2024-01-01 00:00:00"},{"2024-01-02 00:00:00"}}', "timestamp[]")).toEqual([
      ["2024-01-01T00:00:00"],
      ["2024-01-02T00:00:00"],
    ])
  })

  it("reads an empty array", () => {
    expect(valueForColumn("{}", "timestamptz[]")).toEqual([])
  })
})

describe("a change read from the slot", () => {
  it("converts both sides of an update key and a delete's key", () => {
    const deleted = JSON.stringify({
      change: [
        {
          kind: "delete",
          schema: "public",
          table: "auction",
          oldkeys: { keynames: ["endsAt"], keytypes: ["timestamp with time zone"], keyvalues: ["2024-01-01 12:00:00+00"] },
        },
      ],
    })
    expect(parseWal2json(deleted)[0]?.oldRecord).toEqual({ endsAt: "2024-01-01T12:00:00+00:00" })
  })

  it("still hands numerics back as before", () => {
    const [change] = parseWal2json(insert({ n: ["integer", "42"], big: ["bigint", "9007199254740993"] }))
    expect(change?.newRecord).toEqual({ n: 42, big: "9007199254740993" })
  })
})

describe("arrays of every other type", () => {
  it("reads integer and floating point arrays as numbers", () => {
    expect(valueForColumn("{1,2,NULL}", "integer[]")).toEqual([1, 2, null])
    expect(valueForColumn("{1.5,-2}", "double precision[]")).toEqual([1.5, -2])
    expect(valueForColumn("{1,2}", "smallint[]")).toEqual([1, 2])
  })

  it("keeps bigint and numeric elements exact, as strings", () => {
    expect(valueForColumn("{9007199254740993}", "bigint[]")).toEqual(["9007199254740993"])
    expect(valueForColumn("{10.00,2.50}", "numeric(12,2)[]")).toEqual(["10.00", "2.50"])
  })

  it("reads boolean arrays as booleans", () => {
    expect(valueForColumn("{t,f,NULL}", "boolean[]")).toEqual([true, false, null])
  })

  it("reads text and uuid arrays as strings, with quoting undone", () => {
    expect(valueForColumn('{a,"b c","d\\"e","NULL",""}', "text[]")).toEqual(["a", "b c", 'd"e', "NULL", ""])
    expect(valueForColumn("{0a1b2c3d-0000-0000-0000-000000000000}", "uuid[]")).toEqual([
      "0a1b2c3d-0000-0000-0000-000000000000",
    ])
  })

  it("reads a character varying array with a width", () => {
    expect(valueForColumn("{x,y}", "character varying(80)[]")).toEqual(["x", "y"])
  })

  it("reads date arrays as the date strings REST sends", () => {
    expect(valueForColumn("{2024-01-01,2024-01-02}", "date[]")).toEqual(["2024-01-01", "2024-01-02"])
  })

  it("reads a nested integer array", () => {
    expect(valueForColumn("{{1,2},{3,4}}", "integer[]")).toEqual([[1, 2], [3, 4]])
  })

  it("leaves an unreadable literal as it came", () => {
    expect(valueForColumn("{1,2", "integer[]")).toBe("{1,2")
    expect(valueForColumn("[0:1]={1,2}", "integer[]")).toBe("[0:1]={1,2}")
  })
})

describe("a filter on an array column", () => {
  it("still matches the literal the filter is written as", () => {
    const [change] = parseWal2json(insert({ tags: ["text[]", "{a,b}"] }))
    expect(matchesFilter(change as WalChange, { tags: "eq.{a,b}" })).toBe(true)
    expect(matchesFilter(change as WalChange, { tags: "eq.{a,c}" })).toBe(false)
  })
})

describe("array columns of exact values", () => {
  it("names bigint[] and numeric[] as exact kinds, so the client keeps their elements exact", () => {
    expect(exactColumnsOf(["a", "b", "c"], ["bigint[]", "numeric(12,2)[]", "bigint"])).toEqual({ a: "bigint[]", b: "numeric[]", c: "bigint" })
  })

  it("quotes an element that needs it when matching a filter", () => {
    const [change] = parseWal2json(insert({ tags: ["text[]", '{"b c",d}'] }))
    expect(matchesFilter(change as WalChange, { tags: 'eq.{"b c",d}' })).toBe(true)
  })
})

// The 0.9.3 run saw commitTimestamp arrive as "2026-11-15 20:11:03.607447+00", wal2json's text,
// while the row's own timestamptz columns were ISO 8601: Safari and Firefox read the first as
// Invalid Date, as they did the columns before.
describe("the commit timestamp", () => {
  it("is ISO 8601, like the row's timestamptz columns", () => {
    const row = JSON.parse(insert({ id: ["integer", 1] })) as Record<string, unknown>
    const [change] = parseWal2json(JSON.stringify({ ...row, timestamp: "2026-11-15 20:11:03.607447+00" }))
    expect(change?.commitTimestamp).toBe("2026-11-15T20:11:03.607447+00:00")
  })
})
