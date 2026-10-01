import { describe, expect, it } from "vitest"
import { adoptResultFrom } from "../src/dev-compose.js"

/**
 * The engine prints the adopt preview as multi-line JSON. Read with stderr joined on, any warning a
 * compose run prints made it unparseable, and a preview that worked was reported as a failed adopt.
 */
const PREVIEW = JSON.stringify(
  { status: "preview", stampStatements: ['COMMENT ON TABLE "public"."orders" IS \'...\''] },
  null,
  2,
)

describe("adoptResultFrom()", () => {
  it("reads the preview from stdout even when stderr printed something", () => {
    const run = {
      status: 0,
      stdout: PREVIEW,
      output: `${PREVIEW}\nWARN[0000] The "FOO" variable is not set. Defaulting to a blank string.`,
    }
    expect(adoptResultFrom(run)?.stampStatements).toHaveLength(1)
  })

  it("is null for a run that failed, whatever it printed", () => {
    expect(adoptResultFrom({ status: 1, stdout: PREVIEW, output: PREVIEW })).toBeNull()
  })
})
