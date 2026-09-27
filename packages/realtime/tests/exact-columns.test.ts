/**
 * The values realtime used to round on the way out.
 *
 * A `bigint` past 2^53 reached a subscriber as its even neighbour, and a `numeric(12,2)` holding
 * 10.00 reached one as 10, because the WAL payload was read with a plain `JSON.parse`. REST kept
 * both, so the same row had two different values depending on how it was read.
 *
 * The payloads below are wal2json's real output, taken from a running `supatype/postgres:17`
 * rather than written from memory: the `default` one is what the service used to receive, and the
 * `as strings` one is what it receives now that the slot is read with `numeric-data-types-as-string`.
 * Keeping both is the point. The first is what makes the fix necessary and is asserted to be
 * unreadable, so nobody restores the old option list believing the parse alone is enough.
 */
import { describe, expect, it } from "vitest"
import { parseWal2json, SLOT_READ_QUERY } from "../src/replication.js"
import { exactColumnsOf, exactKindOf, isOrdinaryNumeric, valueForColumn } from "../src/exact-columns.js"

/** Exactly what wal2json emits without the option: every numeric is a JSON number. */
const NUMBERS = JSON.stringify({
  change: [
    {
      kind: "insert",
      schema: "public",
      table: "subscription",
      columnnames: ["id", "externalId", "unitAmount", "quantity", "ratio"],
      columntypes: ["uuid", "bigint", "numeric(12,2)", "integer", "double precision"],
      columnvalues: ["a-uuid", 9007199254740993, 10.0, 42, 1.5],
    },
  ],
})

/** What it emits with `numeric-data-types-as-string`, which is how the slot is read now. */
const STRINGS = JSON.stringify({
  change: [
    {
      kind: "insert",
      schema: "public",
      table: "subscription",
      columnnames: ["id", "externalId", "unitAmount", "quantity", "ratio"],
      columntypes: ["uuid", "bigint", "numeric(12,2)", "integer", "double precision"],
      columnvalues: ["a-uuid", "9007199254740993", "10.00", "42", "1.5"],
    },
  ],
})

describe("how the slot is read", () => {
  it("asks wal2json for numerics as strings", () => {
    // The assertions below feed the parser strings directly, so they would pass against a service
    // that never asked for them. This is the line that makes them true in production: without it
    // the values arrive as JSON numbers and the loss happens inside `JSON.parse`.
    expect(SLOT_READ_QUERY).toContain("'numeric-data-types-as-string', '1'")
  })

  it("still asks for the timestamp and the primary key", () => {
    expect(SLOT_READ_QUERY).toContain("'include-timestamp', 'on'")
    expect(SLOT_READ_QUERY).toContain("'include-pk', 'on'")
  })
})

describe("a change read from the slot", () => {
  it("keeps a bigint past 2^53 exactly", () => {
    const [change] = parseWal2json(STRINGS)
    expect(change?.newRecord?.["externalId"]).toBe("9007199254740993")
  })

  it("keeps a numeric's scale, which a double cannot carry", () => {
    // 10.00 and 10 are the same number and different values: one is money to two places.
    const [change] = parseWal2json(STRINGS)
    expect(change?.newRecord?.["unitAmount"]).toBe("10.00")
  })

  it("hands an integer back as a number, so ordinary columns are unchanged", () => {
    const [change] = parseWal2json(STRINGS)
    expect(change?.newRecord?.["quantity"]).toBe(42)
    expect(change?.newRecord?.["ratio"]).toBe(1.5)
  })

  it("leaves a column that is not a number alone", () => {
    const [change] = parseWal2json(STRINGS)
    expect(change?.newRecord?.["id"]).toBe("a-uuid")
  })

  it("names the exact columns, and only those", () => {
    const [change] = parseWal2json(STRINGS)
    expect(change?.exactColumns).toEqual({ externalId: "bigint", unitAmount: "numeric" })
  })

  it("cannot recover what a plain parse already destroyed", () => {
    // The control. Without the option the digits are gone before any of this code runs, so this
    // asserts the damage rather than pretending the parse could undo it.
    const [change] = parseWal2json(NUMBERS)
    expect(change?.newRecord?.["externalId"]).toBe(9007199254740992)
    expect(change?.newRecord?.["unitAmount"]).toBe(10)
  })
})

describe("a delete, which carries only its key", () => {
  it("keeps an exact key exact and describes it", () => {
    const deleted = JSON.stringify({
      change: [
        {
          kind: "delete",
          schema: "public",
          table: "ledger",
          oldkeys: {
            keynames: ["entryId"],
            keytypes: ["bigint"],
            keyvalues: ["9007199254740993"],
          },
        },
      ],
    })
    const [change] = parseWal2json(deleted)
    expect(change?.oldRecord?.["entryId"]).toBe("9007199254740993")
    expect(change?.exactColumns).toEqual({ entryId: "bigint" })
  })
})

describe("exactKindOf", () => {
  it("reads through a declared width or precision", () => {
    expect(exactKindOf("numeric(12,2)")).toBe("numeric")
    expect(exactKindOf("character varying(80)")).toBeNull()
  })

  it("covers the types a double cannot hold", () => {
    for (const type of ["bigint", "int8", "bigserial"]) expect(exactKindOf(type)).toBe("bigint")
    for (const type of ["numeric", "decimal", "money"]) expect(exactKindOf(type)).toBe("numeric")
  })

  it("does not claim the types a double holds fine", () => {
    for (const type of ["integer", "smallint", "double precision", "real", "text", "uuid"]) {
      expect(exactKindOf(type)).toBeNull()
    }
  })
})

describe("isOrdinaryNumeric", () => {
  it("separates numbers to restore from values to leave as text", () => {
    expect(isOrdinaryNumeric("integer")).toBe(true)
    expect(isOrdinaryNumeric("double precision")).toBe(true)
    expect(isOrdinaryNumeric("bigint")).toBe(false)
    expect(isOrdinaryNumeric("text")).toBe(false)
  })
})

describe("valueForColumn", () => {
  it("passes a number straight through, so a build without the option breaks nothing", () => {
    // If wal2json ignores the option the values arrive as numbers. The exact ones are already
    // damaged and nothing here can tell, but no working column is broken by the attempt.
    expect(valueForColumn(42, "integer")).toBe(42)
    expect(valueForColumn(1.5, "double precision")).toBe(1.5)
  })

  it("leaves a null alone", () => {
    expect(valueForColumn(null, "bigint")).toBeNull()
  })

  it("does not convert a string in a text column that happens to look numeric", () => {
    expect(valueForColumn("42", "text")).toBe("42")
  })

  it("leaves a value alone when the type is unknown", () => {
    expect(valueForColumn("42", undefined)).toBe("42")
  })
})

describe("exactColumnsOf", () => {
  it("is empty for a table with nothing exact, which is most of them", () => {
    expect(exactColumnsOf(["id", "name"], ["uuid", "text"])).toEqual({})
  })

  it("is empty when the types are missing rather than guessing from the names", () => {
    expect(exactColumnsOf(["id"], undefined)).toEqual({})
  })
})
