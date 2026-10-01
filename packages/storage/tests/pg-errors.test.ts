/**
 * The SQLSTATEs the storage service reads, pinned.
 *
 * Each decides whether a write answers 403, 409 or 500, so a wrong one either leaks a refusal as a
 * crash or, worse, turns a real fault into a quiet "no". A refusal for want of a grant shares its
 * SQLSTATE with a policy refusal; `db.ts` tells them apart by checking the grants before it writes,
 * which is why `isPolicyViolation` may treat 42501 as the rule working.
 */
import { describe, expect, it } from "vitest"
import { isPolicyViolation, isUniqueViolation } from "../src/pg-errors.js"

/** What `pg` throws: an Error carrying the SQLSTATE on `code`. */
function pgError(code: string, message = "some database error"): Error {
  return Object.assign(new Error(message), { code })
}

describe("isPolicyViolation", () => {
  it("recognises insufficient_privilege, which is what a refusing policy raises", () => {
    expect(isPolicyViolation(pgError("42501", "new row violates row-level security policy"))).toBe(true)
  })

  it("does not claim any other database error", () => {
    // Each of these is a real fault that must keep propagating. Swallowing one would turn a broken
    // deployment into a silent refusal.
    for (const code of ["42P01", "23505", "08006", "57014", "40001"]) {
      expect(isPolicyViolation(pgError(code)), `SQLSTATE ${code}`).toBe(false)
    }
  })

  it("does not match on the message, which is not a contract", () => {
    // The wording is Postgres's and varies by locale and version. The SQLSTATE does not.
    expect(isPolicyViolation(new Error("new row violates row-level security policy"))).toBe(false)
  })
})

describe("isUniqueViolation", () => {
  it("recognises unique_violation and nothing else", () => {
    expect(isUniqueViolation(pgError("23505"))).toBe(true)
    expect(isUniqueViolation(pgError("42501"))).toBe(false)
  })
})

describe("both", () => {
  it("survive the things that are not errors at all", () => {
    for (const value of [null, undefined, "42501", 42501, {}]) {
      expect(isPolicyViolation(value)).toBe(false)
      expect(isUniqueViolation(value)).toBe(false)
    }
  })
})
