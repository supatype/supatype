import { describe, expect, it } from "vitest"
import { seedFailureText } from "../src/commands/seed.js"

/**
 * The engine writes the remedy of a schema-drift failure into its message and into `remedy`, so
 * the CLI printed "Run `supatype generate` ..." twice.
 */

const REMEDY = "Run `supatype generate` to rebuild the seed builder, or `supatype push` if the database is the stale one."

describe("seedFailureText()", () => {
  it("prints a remedy the message already carries once", () => {
    const text = seedFailureText({
      kind: "schemaDrift",
      message: `the database does not have a column this seed writes: column "posts_id" does not exist\n  ${REMEDY}`,
      remedy: REMEDY,
      file: "supatype/seed.ts",
      path: "operations[0]",
    })
    expect(text.split(REMEDY)).toHaveLength(2)
    expect(text).toContain("at supatype/seed.ts operations[0]")
  })

  it("adds a remedy the message does not carry", () => {
    const text = seedFailureText({ kind: "validation", message: "`x` is not a field.", remedy: "Use y." })
    expect(text).toBe("`x` is not a field.\n  Use y.")
  })
})
