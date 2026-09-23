import { describe, expect, it } from "vitest"
import {
  filterIsMaskSafe,
  maskRecord,
  parseMaskLabel,
  parsePredicateRef,
  quotePredicateRef,
} from "../src/field-mask.js"

// A masked column reaching a subscriber is the gap this module exists to close: logical
// decoding never plans a query, so the planner rewrite that masks REST reads cannot reach
// a WAL record. These tests cover the parts that decide what gets nulled.

describe("parsePredicateRef", () => {
  it("reads the shape the engine generates", () => {
    expect(parsePredicateRef('public."can_read_posts__salary"')).toEqual({
      schema: "public",
      name: "can_read_posts__salary",
    })
  })

  it("accepts bare and unqualified names", () => {
    expect(parsePredicateRef("can_read_posts__salary")).toEqual({
      name: "can_read_posts__salary",
    })
    expect(parsePredicateRef("public.can_read")).toEqual({ schema: "public", name: "can_read" })
  })

  it("keeps quoted identifiers verbatim, including doubled quotes", () => {
    expect(parsePredicateRef('"weird ""name"""')).toEqual({ name: 'weird "name"' })
  })

  // A label is written by whoever owns the table, so its contents are untrusted input to a
  // connection that runs as the subscriber. Anything not an identifier is refused outright.
  it.each([
    ["a.b.c", "three parts"],
    ["", "empty"],
    ["public.", "trailing dot"],
    ['"unterminated', "unterminated quote"],
    ["can_read(); DROP TABLE users --", "statement"],
    ["1bad", "leading digit"],
    ["a b", "space"],
  ])("refuses %s (%s)", (input) => {
    expect(parsePredicateRef(input)).toBeNull()
  })
})

describe("quotePredicateRef", () => {
  it("emits a quoted identifier, never raw text", () => {
    expect(quotePredicateRef({ schema: "public", name: "can_read" })).toBe(
      '"public"."can_read"',
    )
  })

  // Belt and braces: even if a hostile name got past parsing it can only ever become an
  // identifier, not SQL.
  it("escapes embedded quotes", () => {
    expect(quotePredicateRef({ name: 'x"; DROP TABLE y --' })).toBe(
      '"x""; DROP TABLE y --"',
    )
  })
})

describe("parseMaskLabel", () => {
  it("reads a read-only label", () => {
    expect(parseMaskLabel('MASK READ public."can_read_posts__salary"')).toEqual({
      read: { schema: "public", name: "can_read_posts__salary" },
    })
  })

  it("reads a read and write label", () => {
    const parsed = parseMaskLabel(
      'MASK READ public."can_read_t__c" WRITE public."can_write_t__c"',
    )
    expect(parsed?.read?.name).toBe("can_read_t__c")
    expect(parsed?.write?.name).toBe("can_write_t__c")
  })

  // A write-only rule leaves reads alone, so realtime must not mask the column at all.
  it("reads a write-only label with no read predicate", () => {
    const parsed = parseMaskLabel('MASK WRITE public."can_write_t__c"')
    expect(parsed?.read).toBeUndefined()
    expect(parsed?.write?.name).toBe("can_write_t__c")
  })

  it("is case-insensitive on keywords", () => {
    expect(parseMaskLabel("mask read can_read")).toEqual({ read: { name: "can_read" } })
  })

  it.each([
    ["HIDE READ can_read", "wrong leading keyword"],
    ["MASK PEEK can_read", "unknown keyword"],
    ["MASK READ", "missing value"],
    ["MASK READ a.b.c", "unparseable predicate"],
  ])("refuses %s (%s)", (input) => {
    expect(parseMaskLabel(input)).toBeNull()
  })
})

describe("maskRecord", () => {
  const record = { id: 1, title: "hello", salary: 100, ssn: "x" }

  it("nulls a column the subscriber may not read", () => {
    const masked = maskRecord(record, ["salary"], new Map([["salary", false]]))
    expect(masked).toEqual({ id: 1, title: "hello", salary: null, ssn: "x" })
  })

  it("leaves a column the subscriber may read", () => {
    const masked = maskRecord(record, ["salary"], new Map([["salary", true]]))
    expect(masked?.["salary"]).toBe(100)
  })

  // Unknown must never resolve to disclosure: a predicate returning NULL, and a column the
  // verdict query never answered for, both mask.
  it.each([
    ["a null verdict", new Map([["salary", null]])],
    ["no verdict at all", new Map()],
  ])("masks on %s", (_label, verdicts) => {
    const masked = maskRecord(record, ["salary"], verdicts as Map<string, boolean | null>)
    expect(masked?.["salary"]).toBeNull()
  })

  // An unchanged TOASTed column is absent from the WAL record. Adding it back as an
  // explicit null would report it as having been cleared.
  it("leaves an absent column absent rather than nulling it", () => {
    const masked = maskRecord({ id: 1 }, ["salary"], new Map([["salary", false]]))
    expect(masked).toEqual({ id: 1 })
    expect(masked && "salary" in masked).toBe(false)
  })

  it("does not copy when nothing is masked", () => {
    expect(maskRecord(record, [], new Map())).toBe(record)
  })

  it("passes a null record through", () => {
    expect(maskRecord(null, ["salary"], new Map())).toBeNull()
  })
})

describe("filterIsMaskSafe", () => {
  it("allows the cheap pre-filter when nothing is restricted", () => {
    expect(filterIsMaskSafe({ salary: "eq.100" }, new Set())).toBe(true)
  })

  it("allows it when the filter names no restricted column", () => {
    expect(filterIsMaskSafe({ title: "eq.hello" }, new Set(["salary"]))).toBe(true)
  })

  // The oracle: filtering on a column you cannot read turns "did I receive this event" into
  // a read of the value. A handful of subscriptions would binary-search it.
  it("refuses it when the filter names a restricted column", () => {
    expect(filterIsMaskSafe({ salary: "eq.100000" }, new Set(["salary"]))).toBe(false)
  })

  it("refuses it when the restricted set is unknown", () => {
    expect(filterIsMaskSafe({ title: "eq.hello" }, new Set(["*"]))).toBe(false)
  })
})
