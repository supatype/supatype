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
import { valueForColumn } from "../src/exact-columns.js"

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
