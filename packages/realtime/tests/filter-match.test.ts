import { describe, expect, it } from "vitest"
import { compareKindOf, matchesFilter, temporalMicros } from "../src/filter-match.js"
import { parseWal2json } from "../src/replication.js"
import type { WalChange } from "../src/types.js"

/**
 * Subscriber column filters compared by the column's type (F65, T1-N3).
 *
 * `salary=gt.100000` delivered salaries of 95000 and 96000, because the values were compared as
 * strings and "95000" sorts after "100000".
 */

const change = (row: Record<string, unknown>, types: Record<string, string>): WalChange => ({
  schema: "public",
  table: "t",
  event: "INSERT",
  newRecord: row,
  oldRecord: null,
  exactColumns: {},
  columnTypes: types,
  commitTimestamp: "",
})

const matches = (value: unknown, type: string, condition: string): boolean =>
  matchesFilter(change({ c: value }, { c: type }), { c: condition })

describe("numeric filters", () => {
  it("compares integers as numbers (T1-N3)", () => {
    expect(matches(95000, "integer", "gt.100000")).toBe(false)
    expect(matches(96000, "integer", "gt.100000")).toBe(false)
    expect(matches(120000, "integer", "gt.100000")).toBe(true)
  })

  it("compares doubles, including equal values written differently", () => {
    expect(matches(9.5, "double precision", "lt.10")).toBe(true)
    expect(matches(10, "double precision", "eq.10.0")).toBe(true)
  })

  it("compares bigint and numeric exactly, as the strings they arrive as", () => {
    expect(matches("9007199254740993", "bigint", "gt.9007199254740992")).toBe(true)
    expect(matches("9007199254740993", "bigint", "eq.9007199254740992")).toBe(false)
    expect(matches("10.00", "numeric(12,2)", "eq.10")).toBe(true)
    expect(matches("-2.5", "numeric", "lt.-2.25")).toBe(true)
    expect(matches("-0.00", "numeric", "eq.0")).toBe(true)
    expect(matches("95000", "numeric", "gte.100000")).toBe(false)
  })

  it("refuses a value that is not a number rather than guessing", () => {
    expect(matches(5, "integer", "neq.abc")).toBe(false)
  })
})

describe("boolean filters", () => {
  it("accepts the spellings Postgres accepts", () => {
    expect(matches(true, "boolean", "eq.true")).toBe(true)
    expect(matches(true, "boolean", "eq.t")).toBe(true)
    expect(matches(false, "boolean", "eq.true")).toBe(false)
    expect(matches(false, "bool", "neq.true")).toBe(true)
  })
})

describe("date and time filters", () => {
  it("orders timestamps by instant, not by spelling", () => {
    const at = "2026-10-10 09:30:00.123456+00"
    expect(matches(at, "timestamp with time zone", "gt.2026-10-10T09:30:00.123Z")).toBe(true)
    expect(matches(at, "timestamp with time zone", "eq.2026-10-10T11:30:00.123456+02:00")).toBe(true)
    expect(matches(at, "timestamptz", "lt.2026-10-09T23:59:59Z")).toBe(false)
  })

  it("orders dates and times", () => {
    expect(matches("2026-10-10", "date", "gt.2026-9-1")).toBe(false) // not a date literal
    expect(matches("2026-10-10", "date", "gt.2026-09-01")).toBe(true)
    expect(matches("09:05:00", "time without time zone", "lt.10:00")).toBe(true)
  })

  it("keeps microseconds", () => {
    expect(temporalMicros("2026-01-01 00:00:00.000001", "timestamp")).toBe(
      (temporalMicros("2026-01-01 00:00:00", "timestamp") ?? 0n) + 1n,
    )
  })
})

describe("text filters", () => {
  it("compares text as text", () => {
    expect(matches("SSN-B-222", "text", "eq.SSN-B-222")).toBe(true)
    expect(matches("b", "character varying(80)", "gt.a")).toBe(true)
  })

  it("compares a uuid regardless of case", () => {
    expect(matches("6a1f0c3e-0000-4000-8000-00000000abcd", "uuid", "eq.6A1F0C3E-0000-4000-8000-00000000ABCD")).toBe(true)
  })

  it("treats an unknown type as text", () => {
    expect(compareKindOf(undefined)).toBe("text")
    expect(compareKindOf("integer[]")).toBe("text")
    expect(compareKindOf("my_enum")).toBe("text")
  })
})

describe("NULL and absent values", () => {
  it("match no comparison, as in SQL", () => {
    expect(matches(null, "integer", "neq.5")).toBe(false)
    expect(matches(null, "text", "eq.x")).toBe(false)
    expect(matchesFilter(change({}, {}), { c: "neq.x" })).toBe(false)
  })

  it("lets a change through when there is no filter or no row", () => {
    expect(matchesFilter(change({ c: 1 }, { c: "integer" }), {})).toBe(true)
    expect(matchesFilter({ ...change({}, {}), newRecord: null }, { c: "eq.1" })).toBe(true)
  })
})

describe("column types from wal2json", () => {
  it("are carried on the change, from both the new row and the old keys", () => {
    const [parsed] = parseWal2json(
      JSON.stringify({
        change: [
          {
            kind: "update",
            schema: "public",
            table: "employee",
            columnnames: ["id", "salary"],
            columntypes: ["uuid", "integer"],
            columnvalues: ["u", "95000"],
            oldkeys: { keynames: ["id"], keytypes: ["uuid"], keyvalues: ["u"] },
          },
        ],
      }),
    )
    expect(parsed?.columnTypes).toEqual({ id: "uuid", salary: "integer" })
    expect(matchesFilter(parsed!, { salary: "gt.100000" })).toBe(false)
  })
})
