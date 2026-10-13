import { describe, expect, it, vi } from "vitest"
import { getErrorDocumentation } from "../src/error-codes-doc.js"
import { PostgrestErrorCodes } from "../src/errors.js"
import { MutationBuilder, QueryBuilder } from "../src/query.js"

/**
 * The codes PostgREST 14 answers with, recorded from a live `postgrest/postgrest:v14.18` against
 * Postgres 17, and the constant a caller would compare each one with.
 *
 * Two of these moved in PostgREST 13: an expired token is `PGRST303` (it was `PGRST301`), and a
 * missing table is `PGRST205` (it was the SQLSTATE `42P01`). A database error is passed through
 * under its SQLSTATE, with no `PGRST` prefix, so a constant spelled `PGRST23505` never matched a
 * unique violation in any release.
 */
const RECORDED: Array<{ case: string; status: number; code: string; constant: string }> = [
  { case: "expired JWT", status: 401, code: "PGRST303", constant: PostgrestErrorCodes.JWT_EXPIRED },
  { case: "JWT with a bad signature", status: 401, code: "PGRST301", constant: PostgrestErrorCodes.JWT_INVALID },
  { case: "missing table", status: 404, code: "PGRST205", constant: PostgrestErrorCodes.UNDEFINED_TABLE },
  { case: "insert into an unknown column", status: 400, code: "PGRST204", constant: PostgrestErrorCodes.SCHEMA_CACHE_MISS },
  { case: "single() with no rows", status: 406, code: "PGRST116", constant: PostgrestErrorCodes.NOT_FOUND },
  { case: "row-level security denial, signed in", status: 403, code: "42501", constant: PostgrestErrorCodes.PERMISSION_DENIED },
  { case: "foreign key violation", status: 409, code: "23503", constant: PostgrestErrorCodes.FK_VIOLATION },
  { case: "unique violation", status: 409, code: "23505", constant: PostgrestErrorCodes.UNIQUE_VIOLATION },
  { case: "not-null violation", status: 400, code: "23502", constant: PostgrestErrorCodes.NOT_NULL_VIOLATION },
  { case: "check violation", status: 400, code: "23514", constant: PostgrestErrorCodes.CHECK_VIOLATION },
  { case: "invalid input syntax", status: 400, code: "22P02", constant: PostgrestErrorCodes.INVALID_INPUT },
  { case: "filter on an unknown column", status: 400, code: "42703", constant: PostgrestErrorCodes.UNDEFINED_COLUMN },
]

/** PostgREST 14's message for a `vnd.pgrst.object+json` request that did not find one row. */
const SINGLE_ROW_MESSAGE = "Cannot coerce the result to a single JSON object"

describe("PostgREST error codes", () => {
  it.each(RECORDED)("$case: the constant is the code PostgREST answers", ({ code, constant }) => {
    expect(constant).toBe(code)
  })

  it.each(RECORDED)("$case: the documentation has an entry for the code", ({ code, status }) => {
    const entry = getErrorDocumentation(code)
    expect(entry?.category).toBe("postgrest")
    expect(entry?.httpStatus).toBe(status)
  })
})

describe("single() without exactly one row", () => {
  const emptyArray = (): Response =>
    new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })

  it("a read words it as PostgREST does", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(emptyArray()))
    const { error } = await new QueryBuilder("http://x", "/rest/v1/t", {}).single()
    vi.unstubAllGlobals()
    expect(error).toEqual({ message: SINGLE_ROW_MESSAGE, code: "PGRST116" })
  })

  it("a write words it as PostgREST does", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(emptyArray()))
    const { error } = await new MutationBuilder("http://x", "/rest/v1/t", {}, "PATCH", {}).single()
    vi.unstubAllGlobals()
    expect(error).toEqual({ message: SINGLE_ROW_MESSAGE, code: "PGRST116" })
  })
})
