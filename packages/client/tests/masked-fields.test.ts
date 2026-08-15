import { describe, expect, it } from "vitest"
import { parseMaskedFields } from "../src/query.js"

// A column you may not read comes back as `null`, because Postgres cannot omit a column from
// a result set. On the wire that is indistinguishable from a value that is genuinely null.
// This header is what tells the two apart — advisory only, so parsing it must fail towards
// saying nothing rather than towards saying something wrong.

describe("parseMaskedFields", () => {
  it("reads a single entry", () => {
    expect(parseMaskedFields("salary=identity")).toEqual([
      { column: "salary", scope: "identity" },
    ])
  })

  it("reads several entries and tolerates the spacing the server sends", () => {
    expect(parseMaskedFields("salary=row, ssn=identity")).toEqual([
      { column: "salary", scope: "row" },
      { column: "ssn", scope: "identity" },
    ])
  })

  it("is undefined when nothing is restricted", () => {
    expect(parseMaskedFields(null)).toBeUndefined()
    expect(parseMaskedFields("")).toBeUndefined()
    expect(parseMaskedFields("   ")).toBeUndefined()
  })

  // A newer server may describe a scope this client does not know. Dropping the entry
  // degrades to silence; keeping it would let app code branch on a value it cannot interpret.
  it("drops entries it does not understand rather than guessing", () => {
    expect(parseMaskedFields("salary=someFutureScope")).toBeUndefined()
    expect(parseMaskedFields("salary=row, ssn=someFutureScope")).toEqual([
      { column: "salary", scope: "row" },
    ])
  })

  it("drops malformed entries", () => {
    expect(parseMaskedFields("salary")).toBeUndefined()
    expect(parseMaskedFields("=row")).toBeUndefined()
    expect(parseMaskedFields(",,")).toBeUndefined()
  })

  // `scope` is the whole point of the distinction: `identity` means every null in that column
  // is explicable by masking, `row` means only some are.
  it("keeps the scope distinction intact", () => {
    const fields = parseMaskedFields("a=identity, b=row")
    expect(fields?.find((f) => f.column === "a")?.scope).toBe("identity")
    expect(fields?.find((f) => f.column === "b")?.scope).toBe("row")
  })
})
